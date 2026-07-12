import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/** Spawn a node script; resolve with its exit code. */
const spawned = (script, args) =>
  new Promise((resolve) => {
    const child = spawn('node', [script, ...args], { encoding: 'utf8' });
    child.on('close', (code) => resolve(code));
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
for (;;) {
  try {
    withLock(root, io, () => {
      t0 = Date.now();
      const end = t0 + 150;
      while (Date.now() < end) { /* hold the lock, visibly */ }
      t1 = Date.now();
    });
    break;
  } catch { /* held — keep trying until we get a turn */ }
}
writeFileSync(barrierDir + '/interval-' + idx, JSON.stringify({ t0, t1 }));
`;

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
    const codes = await Promise.all(children);

    for (let i = 1; i <= N; i++) {
      const done = JSON.parse(readFileSync(join(barrier, `done-${i}`), 'utf8'));
      assert.equal(done.status, 0, `writer ${i} exited 0; stderr: ${done.stderr}`);
    }
    assert.deepEqual(codes, Array(N).fill(0));

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
    await Promise.all(children);

    const a = JSON.parse(readFileSync(join(barrier, 'interval-1'), 'utf8'));
    const b = JSON.parse(readFileSync(join(barrier, 'interval-2'), 'utf8'));
    assert.ok(a.t0 > 0 && b.t0 > 0, 'both holders eventually acquired the lock');
    const overlap = a.t0 < b.t1 && b.t0 < a.t1;
    assert.equal(overlap, false, `critical sections overlap: A=[${a.t0},${a.t1}] B=[${b.t0},${b.t1}]`);
  });
});
