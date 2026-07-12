import { atomicWriteJson } from '../util/fsx.mjs';
import { appendEntry, readAllTolerant } from '../util/jsonl.mjs';
import { dedupeKey } from '../util/ids.mjs';
import { checkHandoffTree } from '../util/jail.mjs';

/**
 * Operation-scoped mutation lock (plan §Concurrency, Lock model).
 * Acquire = atomic non-recursive mkdir of .handoff/lock/; exclusivity comes from
 * EEXIST. Ownership facts live in owner.json; logical session ownership lives in
 * bundle.json, never here. Takeover only when the owner is provably dead on this
 * host — every other contended state refuses, and `force` never changes that.
 */

export class LockHeldError extends Error {
  constructor(/** @type {string} */ message) {
    super(message);
    this.name = 'LockHeldError';
  }
}

export class FencingError extends Error {
  constructor(/** @type {string} */ message) {
    super(message);
    this.name = 'FencingError';
  }
}

/** @param {string} root */
function lockPaths(root) {
  const dir = `${root}/.handoff`;
  return {
    dir,
    lockDir: `${dir}/lock`,
    owner: `${dir}/lock/owner.json`,
    journal: `${dir}/journal.ndjson`,
  };
}

const ESCAPE_HATCH =
  'Verify manually that no baton process still holds it, then delete .handoff/lock to clear.';

/**
 * Inspect the current lock state.
 * @param {any} io @param {ReturnType<typeof lockPaths>} p
 * @returns {{state: 'free'} | {state: 'torn', cause: string} | {state: 'live'|'dead'|'cross-host', owner: any}}
 */
function inspect(io, p) {
  if (!io.fs.existsSync(p.lockDir)) return { state: 'free' };
  if (!io.fs.existsSync(p.owner)) {
    return { state: 'torn', cause: 'owner.json is missing (torn lock metadata)' };
  }
  let owner;
  try {
    owner = JSON.parse(io.fs.readFileSync(p.owner, 'utf8'));
  } catch {
    return { state: 'torn', cause: 'owner.json is unparseable (torn lock metadata)' };
  }
  if (owner.host !== io.host) return { state: 'cross-host', owner };
  if (io.processAlive(owner.pid, owner.startTime)) return { state: 'live', owner };
  return { state: 'dead', owner };
}

/** @param {any} io @param {ReturnType<typeof lockPaths>} p @param {string} text */
function journalNote(io, p, text) {
  io.fs.mkdirSync(p.dir, { recursive: true });
  // Allocate seq + dedupeKey like every other journal entry (gate-2 fix,
  // reviewer-b finding 2): a keyless, seq-less note poisons journalSeq to NaN
  // on replay and dedupes every later keyless event. We are already inside the
  // lock here, so reading the tail for allocation is race-free.
  let tailSeq = 0;
  try {
    const snap = JSON.parse(io.fs.readFileSync(`${p.dir}/bundle.json`, 'utf8'));
    if (typeof snap?.journalSeq === 'number') tailSeq = snap.journalSeq;
  } catch {
    // no snapshot yet — journal tail below still counts
  }
  try {
    for (const e of readAllTolerant(io.fs, p.journal).entries) {
      if (typeof e.seq === 'number' && e.seq > tailSeq) tailSeq = e.seq;
    }
  } catch {
    // no journal yet
  }
  const ts = io.now();
  appendEntry(io.fs, p.journal, {
    seq: tailSeq + 1,
    ts,
    type: 'note',
    dedupeKey: dedupeKey({ ts, type: 'note', source: 'lock', text }),
    writerId: ['lock', io.host, io.pid].join('-'),
    source: 'lock',
    payload: { text },
  });
}

/** @param {any} io @param {ReturnType<typeof lockPaths>} p */
function publishOwner(io, p) {
  const token = io.newFencingToken();
  atomicWriteJson(io.fs, p.owner, {
    host: io.host,
    pid: io.pid,
    startTime: io.startTime,
    fencingToken: token,
    acquiredAt: io.now(),
    heartbeatAt: io.now(),
  });
  return token;
}

/** @param {any} io @param {ReturnType<typeof lockPaths>} p */
function acquire(io, p) {
  io.fs.mkdirSync(p.dir, { recursive: true });
  try {
    io.fs.mkdirSync(p.lockDir);
    return publishOwner(io, p);
  } catch (err) {
    if (/** @type {any} */ (err)?.code !== 'EEXIST') throw err;
  }

  const s = inspect(io, p);
  switch (s.state) {
    case 'free':
      // Raced a release between mkdir failure and inspection; retry once. A
      // competitor can win THIS mkdir too (gate-2 fix 12: observed under real
      // barrier-released contention) — that is contention, not corruption.
      try {
        io.fs.mkdirSync(p.lockDir);
      } catch (err) {
        if (/** @type {any} */ (err)?.code === 'EEXIST') {
          throw new LockHeldError('lock was re-acquired by a competitor mid-inspection — transient contention');
        }
        throw err;
      }
      return publishOwner(io, p);
    case 'live':
      throw new LockHeldError(
        `lock is held by a live process (pid ${s.owner.pid} on ${s.owner.host}) — terminate that process first.`,
      );
    case 'cross-host':
      throw new Error(
        `lock is held from another host ('${s.owner.host}', this is '${io.host}') — cross-host locks are never provably safe to steal. ${ESCAPE_HATCH}`,
      );
    case 'torn':
      // During ACQUIRE, torn metadata is usually a competitor caught between
      // its mkdir and owner.json publication — transient by construction, so
      // LockHeldError lets withLock wait it out (gate-2 fix 12). A genuinely
      // crashed publisher exhausts the retry budget and surfaces this same
      // message; recovery semantics (recoverLock) are unchanged: never steal.
      throw new LockHeldError(`${s.cause} — unsupported for automatic recovery. ${ESCAPE_HATCH}`);
    case 'dead': {
      // Atomic re-claim (gate-2 iter-2 B1): remove the stale lock dir and WIN
      // a fresh mkdir before publishing. Two contenders racing the same dead
      // owner arbitrate on that mkdir — the loser gets EEXIST and retries —
      // instead of both republishing owner.json into one shared dir. The
      // fencing token remains the write-time backstop.
      io.fs.rmSync(p.lockDir, { recursive: true, force: true });
      try {
        io.fs.mkdirSync(p.lockDir);
      } catch (err) {
        if (/** @type {any} */ (err)?.code === 'EEXIST') {
          throw new LockHeldError('a competitor re-claimed the dead lock first — transient contention');
        }
        throw err;
      }
      const token = publishOwner(io, p);
      journalNote(io, p, `lock takeover: took over stale lock from dead pid ${s.owner.pid} (start time ${s.owner.startTime})`);
      return token;
    }
    /* c8 ignore next 2 */
    default:
      throw new Error('unreachable lock state');
  }
}

/**
 * Fence-guarded release: the lock dir is removed only while owner.json still
 * carries OUR token. A holder that paused past a takeover must not delete the
 * competitor's lock on its way out — release is a write like any other.
 * @param {any} io @param {ReturnType<typeof lockPaths>} p @param {string} token
 */
function release(io, p, token) {
  try {
    const current = JSON.parse(io.fs.readFileSync(p.owner, 'utf8'));
    if (current.fencingToken !== token) return; // a competitor took over — their lock, not ours
  } catch {
    return; // owner metadata gone or torn mid-hold — never guess; leave it for recovery
  }
  io.fs.rmSync(p.lockDir, { recursive: true, force: true });
}

// A live same-host holder is transient by design — operation-scoped locks are
// held for milliseconds — so contention waits instead of dropping the
// operation (gate-2 fix 12: simultaneous checkpoints must all land). The budget
// is generous (≈15 s): under heavy load a writer may be starved of scheduling
// for seconds, and waiting is strictly safer than silently dropping its work.
// Every other contended state (torn, cross-host) stays fail-fast: waiting
// cannot make those provably safe.
const DEFAULT_RETRY = { attempts: 600, delayMs: 25 };

/** Synchronous sleep without burning a core: Atomics.wait on a throwaway buffer. */
const sleepMs = (/** @type {number} */ ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Acquire → run fn(token) → release (also on throw). Synchronous by design:
 * everything the lock guards is sync fs work. Live-held locks are retried on
 * a bounded budget (override via io.lockRetry = {attempts, delayMs}).
 * @param {string} root @param {any} io @param {(token: string) => any} fn
 */
export function withLock(root, io, fn) {
  const p = lockPaths(root);
  // Jail BEFORE any lock mutation (gate-2 iter-2 B2): a symlinked .handoff or
  // .handoff/lock must never be created into or removed through — that would
  // reach outside the repository. Checked once here, ahead of acquire.
  const safe = checkHandoffTree(root, io);
  if (!safe.ok) throw new Error(`${safe.problem} — refusing to acquire the lock`);
  const retry = io.lockRetry ?? DEFAULT_RETRY;
  /** @type {string} */
  let token;
  for (let attempt = 0; ; attempt++) {
    try {
      token = acquire(io, p);
      break;
    } catch (err) {
      if (err instanceof LockHeldError && attempt < retry.attempts) {
        sleepMs(retry.delayMs);
        continue;
      }
      throw err;
    }
  }
  try {
    return fn(token);
  } finally {
    release(io, p, token);
  }
}

/**
 * Fast-abort layer: re-read the published token immediately before a write; a
 * holder that paused past its last check aborts instead of clobbering.
 * @param {string} root @param {any} io @param {string} token @param {() => any} fn
 */
export function guardedWrite(root, io, token, fn) {
  const p = lockPaths(root);
  let current = null;
  try {
    current = JSON.parse(io.fs.readFileSync(p.owner, 'utf8'));
  } catch {
    throw new FencingError('lock owner metadata is gone — fencing check failed; aborting write');
  }
  if (current.fencingToken !== token) {
    throw new FencingError(
      `fencing token changed (held '${token}', current '${current.fencingToken}') — another process took over; aborting write`,
    );
  }
  return fn();
}

/**
 * Explicit recovery. `force` is an intent flag only — it never changes the
 * decision: exactly one state recovers (provably-dead same-host owner).
 * @param {string} root @param {any} io @param {{force?: boolean}} [opts]
 * @returns {{recovered: boolean, refusedReason: string | null}}
 */
export function recoverLock(root, io, opts = {}) {
  void opts;
  const p = lockPaths(root);
  // Jail before recovery (gate-2 iter-2 B2): recoverLock removes the lock dir,
  // so a symlinked managed tree must be refused first — even with force, a
  // symlink is never provably safe to delete through.
  const safe = checkHandoffTree(root, io);
  if (!safe.ok) return { recovered: false, refusedReason: `${safe.problem} — refusing recovery` };
  const s = inspect(io, p);
  switch (s.state) {
    case 'free':
      return { recovered: true, refusedReason: null };
    case 'dead':
      // Provably-dead owner: removal is justified by the verified state itself,
      // not by holding the fence (there is no live holder to fence against).
      io.fs.rmSync(p.lockDir, { recursive: true, force: true });
      journalNote(io, p, `lock recovery: cleared stale lock of dead pid ${s.owner.pid}`);
      return { recovered: true, refusedReason: null };
    case 'live':
      return {
        recovered: false,
        refusedReason: `lock is held by a live process (pid ${s.owner.pid} on ${s.owner.host}) — terminate that process first.`,
      };
    case 'cross-host':
      return {
        recovered: false,
        refusedReason: `lock is held from another host ('${s.owner.host}', this is '${io.host}') — cross-host locks are never provably safe to steal, even with force. ${ESCAPE_HATCH}`,
      };
    case 'torn':
      return {
        recovered: false,
        refusedReason: `${s.cause} — unsupported for automatic recovery, even with force. ${ESCAPE_HATCH}`,
      };
    /* c8 ignore next 2 */
    default:
      return { recovered: false, refusedReason: 'unreachable lock state' };
  }
}
