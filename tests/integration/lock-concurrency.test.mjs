import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { loadBundle } from '../../core/src/bundle/store.mjs';

// ---------------------------------------------------------------------------
// Gate-2 fix 12 (reviewer-a finding 16): the old concurrency tests staged
// pre-created locks and sequential commits — no writer ever actually raced.
// These tests run REAL child processes released simultaneously by a filesystem
// barrier: every writer must land (bounded lock retry absorbs transient
// contention), sequence numbers stay unique, and lock holds never overlap.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const BATON = join(repoRoot, 'core', 'bin', 'baton.mjs');
const LOCK_URL = pathToFileURL(join(repoRoot, 'core', 'src', 'bundle', 'lock.mjs')).href;

/** @type {string[]} */
const dirs = [];
const scratch = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// Every child is lifetime-bounded (test-verifier finding 1): a lock
// regression must fail the test with diagnostics, never hang the suite.
const CHILD_TIMEOUT_MS = 60_000;

/** Spawn a node script; resolve with {code, stderr}. Kills at the deadline. */
const spawned = (script, args) =>
  new Promise((resolve) => {
    const child = spawn('node', [script, ...args]);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const killer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, stderr });
    });
  });

/** Wait until pred() is true (bounded). */
async function until(pred, ms = 15_000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('barrier timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const WRITER = `
import { writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [bin, root, idx, barrierDir] = process.argv.slice(2);
writeFileSync(barrierDir + '/ready-' + idx, '');
while (!existsSync(barrierDir + '/go')) { /* released by the parent barrier */ }
const payload = JSON.stringify({
  schema: 'baton/event@1', type: 'decision',
  payload: { summary: 'concurrent-' + idx },
  source: 'claude-code', sessionHint: 'conc-sess', unstable: false,
});
const r = spawnSync('node', [bin, 'checkpoint', '--platform', 'claude-code', '--root', root], { input: payload, encoding: 'utf8' });
writeFileSync(barrierDir + '/done-' + idx, JSON.stringify({ status: r.status, stderr: r.stderr }));
process.exit(r.status ?? 1);
`;

const HOLDER = `
import { writeFileSync, existsSync } from 'node:fs';
import * as fs from 'node:fs';
import { hostname } from 'node:os';
const [lockUrl, root, idx, barrierDir] = process.argv.slice(2);
const { withLock } = await import(lockUrl);
const io = {
  fs, host: hostname(), pid: process.pid, startTime: Math.round(performance.timeOrigin),
  now: () => new Date().toISOString(),
  processAlive: () => true, // a live contender is NEVER treated as dead here
  newFencingToken: () => 't-' + process.pid + '-' + Math.random().toString(36).slice(2),
};
writeFileSync(barrierDir + '/ready-' + idx, '');
while (!existsSync(barrierDir + '/go')) { /* barrier */ }
let t0 = 0, t1 = 0;
const deadline = Date.now() + 20_000; // bounded retry: a stuck lock FAILS, never hangs
let lastErr = null;
for (;;) {
  if (Date.now() > deadline) {
    writeFileSync(barrierDir + '/interval-' + idx, JSON.stringify({ t0: 0, t1: 0, error: 'lock never acquired within 20s: ' + String(lastErr) }));
    process.exit(1);
  }
  try {
    withLock(root, io, () => {
      t0 = Date.now();
      const end = t0 + 150;
      while (Date.now() < end) { /* hold the lock, visibly */ }
      t1 = Date.now();
    });
    break;
  } catch (err) { lastErr = err?.message ?? err; /* held — retry until the deadline */ }
}
writeFileSync(barrierDir + '/interval-' + idx, JSON.stringify({ t0, t1 }));
`;

// One provably-dead owner, two real reclaimers. Each does a read-modify-write of
// a shared file INSIDE withLock (no fencing helper — the lock alone must
// serialize). A non-atomic reclaim (rm-then-mkdir) would let both hold at once →
// a lost update AND two takeover notes (iter-3 finding-1). TWO barriers make the
// race deterministic (iter-4 minor): first both processes start, then both
// PROVABLY observe the stale dead owner (observe-dead barrier) before either is
// allowed to reclaim — reproducing the exact double-observe window the old
// rm-then-mkdir needed. The unit white-box trace test is the deterministic
// oracle; this is the real-process liveness+exclusion complement.
const RECLAIMER = `
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import * as fs from 'node:fs';
import { hostname } from 'node:os';
const [lockUrl, root, idx, barrierDir, deadPid] = process.argv.slice(2);
const { withLock } = await import(lockUrl);
// Yield instead of busy-spinning: under full-suite parallelism a tight spin
// starves the peer process and blows the barrier/lock budgets (flake source).
const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
const waitFor = (pred, ms) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) return false; sleep(5); } return true; };
const io = {
  fs, host: hostname(), pid: process.pid, startTime: Math.round(performance.timeOrigin),
  now: () => new Date().toISOString(),
  processAlive: (pid) => String(pid) !== deadPid, // the seeded owner is provably dead
  newFencingToken: () => 't-' + process.pid + '-' + Math.random().toString(36).slice(2),
};
const orderFile = root + '/.handoff/order.txt';
writeFileSync(barrierDir + '/ready-' + idx, '');
if (!waitFor(() => existsSync(barrierDir + '/go'), 40000)) { writeFileSync(barrierDir + '/err-' + idx, 'go barrier timeout'); process.exit(2); }
// Observe-dead barrier: prove we have SEEN the stale dead owner, then wait for
// the peer to have seen it too, so neither reclaims before both observe it.
const owner = JSON.parse(readFileSync(root + '/.handoff/lock/owner.json', 'utf8'));
if (String(owner.pid) !== deadPid) { writeFileSync(barrierDir + '/err-' + idx, 'stale owner not present at observe time'); process.exit(3); }
writeFileSync(barrierDir + '/observed-' + idx, '');
if (!waitFor(() => existsSync(barrierDir + '/observed-1') && existsSync(barrierDir + '/observed-2'), 40000)) { writeFileSync(barrierDir + '/err-' + idx, 'observe barrier timeout'); process.exit(4); }
const deadline = Date.now() + 45000;
for (;;) {
  if (Date.now() > deadline) { writeFileSync(barrierDir + '/err-' + idx, 'never acquired'); process.exit(1); }
  try {
    withLock(root, io, () => {
      let cur = '';
      try { cur = readFileSync(orderFile, 'utf8'); } catch {}
      const end = Date.now() + 25; while (Date.now() < end) { /* brief visible critical section */ }
      writeFileSync(orderFile, cur + idx + '\\n');
    });
    break;
  } catch (e) { /* held/contended — retry until the deadline */ sleep(5); }
}
writeFileSync(barrierDir + '/done-' + idx, 'ok');
`;

describe('dead-lock reclaim under a real barrier-released race (iter-3 finding-1)', () => {
  it('two reclaimers, one dead owner: at most one takeover note, both mutate serialized (no lost update), unique seqs', async () => {
    const root = scratch('baton-reclaim-root-');
    const barrier = scratch('baton-reclaim-barrier-');
    const DEAD_PID = '999999';
    // Seed a provably-dead owner on THIS host so both children agree it is dead.
    mkdirSync(join(root, '.handoff', 'lock'), { recursive: true });
    writeFileSync(
      join(root, '.handoff', 'lock', 'owner.json'),
      JSON.stringify({ host: hostname(), pid: Number(DEAD_PID), startTime: 1, fencingToken: 'STALE', acquiredAt: 'x', heartbeatAt: 'x' }),
    );
    const reclaimerPath = join(barrier, 'reclaimer.mjs');
    writeFileSync(reclaimerPath, RECLAIMER);

    const kids = [1, 2].map((i) => spawned(reclaimerPath, [LOCK_URL, root, String(i), barrier, DEAD_PID]));
    await until(() => existsSync(join(barrier, 'ready-1')) && existsSync(join(barrier, 'ready-2')));
    writeFileSync(join(barrier, 'go'), '');
    const results = await Promise.all(kids);
    for (const [i, r] of results.entries()) {
      assert.equal(r.code, 0, `reclaimer ${i + 1} exited 0 (signal ${r.signal}); stderr: ${r.stderr}`);
    }

    // Mutual exclusion: both critical sections ran serialized, so the order file
    // carries BOTH ids exactly once. A non-atomic reclaim would have lost one
    // read-modify-write (two simultaneous holders clobbering each other).
    const order = readFileSync(join(root, '.handoff', 'order.txt'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .sort();
    assert.deepEqual(order, ['1', '2'], `both reclaimers mutated exactly once under the lock; got ${JSON.stringify(order)}`);

    // AT MOST ONE dead-lock takeover was journaled (iter-3 F2). The takeover
    // note is written under the held lock AFTER publishOwner, so it is
    // best-effort: 0 when the rename winner then loses the fresh-mkdir race to a
    // free-path competitor (and acquires via the free path, which does not
    // journal), 1 otherwise. It is NEVER 2 — that would mean two simultaneous
    // takeovers, which the atomic rename arbitration precludes. Every journal
    // entry (note or event) also has a unique seq (no under-lock collision).
    const journal = existsSync(join(root, '.handoff', 'journal.ndjson'))
      ? readFileSync(join(root, '.handoff', 'journal.ndjson'), 'utf8')
          .split('\n')
          .filter((l) => l.trim() !== '')
          .map((l) => JSON.parse(l))
      : [];
    const takeovers = journal.filter((e) => e.type === 'note' && /took over stale lock from dead/.test(e.payload?.text ?? ''));
    assert.ok(takeovers.length <= 1, `at most one dead-lock takeover is journaled (never a double takeover); got ${takeovers.length}`);
    const seqs = journal.map((e) => e.seq).filter((s) => s !== undefined);
    assert.equal(new Set(seqs).size, seqs.length, `journal seqs are unique (allocated under the lock); got ${JSON.stringify(seqs)}`);
    assert.equal(existsSync(join(root, '.handoff', 'lock')), false, 'the lock dir is released after both operations');
  });
});

describe('barrier-released concurrent writers (real processes, real fs)', () => {
  it('4 simultaneous checkpoints: every event lands, seqs unique, journalSeq sane', async () => {
    const root = scratch('baton-conc-root-');
    const barrier = scratch('baton-conc-barrier-');
    const writerPath = join(barrier, 'writer.mjs');
    writeFileSync(writerPath, WRITER);

    const N = 4;
    const children = [];
    for (let i = 1; i <= N; i++) children.push(spawned(writerPath, [BATON, root, String(i), barrier]));
    await until(() => Array.from({ length: N }, (_, i) => existsSync(join(barrier, `ready-${i + 1}`))).every(Boolean));
    writeFileSync(join(barrier, 'go'), '');
    const results = await Promise.all(children);

    for (let i = 1; i <= N; i++) {
      const r = results[i - 1];
      assert.equal(r.code, 0, `writer wrapper ${i} exited 0 (signal ${r.signal}); stderr: ${r.stderr}`);
      const done = JSON.parse(readFileSync(join(barrier, `done-${i}`), 'utf8'));
      assert.equal(done.status, 0, `writer ${i} exited 0; stderr: ${done.stderr}`);
    }

    // Journal integrity: every writer's event landed exactly once, seqs unique.
    const journal = readFileSync(join(root, '.handoff', 'journal.ndjson'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l));
    const decisions = journal.filter((e) => e.type === 'decision');
    assert.equal(decisions.length, N, `all ${N} concurrent events are in the journal (none dropped under contention)`);
    const seqs = journal.map((e) => e.seq);
    assert.equal(new Set(seqs).size, seqs.length, `sequence numbers are unique: ${JSON.stringify(seqs)}`);
    for (const s of seqs) assert.ok(Number.isFinite(s), 'no NaN/undefined seq anywhere');

    // State integrity: the merged bundle carries every writer's decision.
    const io = {
      cwd: root,
      fs: nodeFs,
      now: () => new Date().toISOString(),
      stdout: { write: () => true },
      stderr: { write: () => true },
    };
    const { bundle } = loadBundle(root, io);
    assert.ok(bundle, 'the bundle loads after the melee');
    for (let i = 1; i <= N; i++) {
      assert.ok(
        bundle.decisions.some((/** @type {any} */ d) => d.summary === `concurrent-${i}`),
        `writer ${i}'s decision survived into the merged bundle`,
      );
    }
    assert.ok(Number.isFinite(bundle.journalSeq), 'journalSeq is a finite number after concurrent writes');
  });

  it('two lock holders released together never overlap their critical sections', async () => {
    const root = scratch('baton-mutex-root-');
    const barrier = scratch('baton-mutex-barrier-');
    const holderPath = join(barrier, 'holder.mjs');
    writeFileSync(holderPath, HOLDER);

    const children = [1, 2].map((i) => spawned(holderPath, [LOCK_URL, root, String(i), barrier]));
    await until(() => existsSync(join(barrier, 'ready-1')) && existsSync(join(barrier, 'ready-2')));
    writeFileSync(join(barrier, 'go'), '');
    const results = await Promise.all(children);
    for (const [i, r] of results.entries()) {
      assert.equal(r.code, 0, `holder ${i + 1} exited 0 (signal ${r.signal}); stderr: ${r.stderr}`);
    }

    const a = JSON.parse(readFileSync(join(barrier, 'interval-1'), 'utf8'));
    const b = JSON.parse(readFileSync(join(barrier, 'interval-2'), 'utf8'));
    assert.equal(a.error ?? null, null, `holder 1 acquired cleanly: ${a.error}`);
    assert.equal(b.error ?? null, null, `holder 2 acquired cleanly: ${b.error}`);
    assert.ok(a.t0 > 0 && b.t0 > 0, 'both holders eventually acquired the lock');
    const overlap = a.t0 < b.t1 && b.t0 < a.t1;
    assert.equal(overlap, false, `critical sections overlap: A=[${a.t0},${a.t1}] B=[${b.t0},${b.t1}]`);
  });
});
