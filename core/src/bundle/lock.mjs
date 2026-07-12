import { atomicWriteJson } from '../util/fsx.mjs';
import { appendEntry, readAllTolerant } from '../util/jsonl.mjs';
import { dedupeKey } from '../util/ids.mjs';

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
      // Raced a release between mkdir failure and inspection; retry once.
      io.fs.mkdirSync(p.lockDir);
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
      throw new Error(`${s.cause} — unsupported for automatic recovery. ${ESCAPE_HATCH}`);
    case 'dead': {
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

/**
 * Acquire → run fn(token) → release (also on throw). Synchronous by design:
 * everything the lock guards is sync fs work.
 * @param {string} root @param {any} io @param {(token: string) => any} fn
 */
export function withLock(root, io, fn) {
  const p = lockPaths(root);
  const token = acquire(io, p);
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
