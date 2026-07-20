import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// ITEM 10 (v1.1) — --detach, the ONE real-fs / real-spawn integration test.
// The command-level pins (loop-run.test.mjs / pipeline-run.test.mjs) drive the
// io.spawnDetached SEAM (parent returns, lock ownership, refuse-live, reclaim,
// ordered kill-before-fork, seam args). THIS test exercises the DEFAULT
// spawnDetached — a genuine detached child_process — to close the real-spawn +
// supervisor.out + detached-release gaps the seam can't reach.
//
// The detached supervisor is forced to a FAST terminal state: the phase's role
// IS defined in config.roles (so validateLoopSpec accepts the spec) but has an
// EMPTY chain, so resolveRoles yields no eligible assignment and the run parks
// immediately (loop.mjs no-eligible-assignment path) — no real claude/codex
// binaries needed, fully deterministic.
//
// SEAM JUDGMENT CALL (flagged): the byte-cap TRUNCATION-under-load is pinned by
// the seam's maxBytes arg (command tests); here supervisor.out is only asserted
// to EXIST and stay bounded — a fast-parking child cannot emit >cap on demand.
// POSIX only — SKIP_WIN (detach is documented unsupported on win32).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const bin = join(repoRoot, 'core', 'bin', 'baton.mjs');
const SKIP_WIN = process.platform === 'win32';

/** @type {string[]} */
const dirs = [];
/** @type {number[]} */
const spawnedPids = [];
after(() => {
  for (const pid of spawnedPids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(/** @type {() => boolean} */ cond, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

function scratchRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'baton-detach-'));
  dirs.push(cwd);
  const git = (/** @type {string[]} */ args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'SakshamUboweja']);
  git(['config', 'user.email', 'ssakshamu@gmail.com']);
  writeFileSync(join(cwd, '.gitignore'), '.handoff/\n.worktrees/\n');
  // 'work-role' is PRESENT (validateLoopSpec passes) but has an EMPTY chain →
  // resolveRoles finds no eligible entry → the detached supervisor parks fast.
  writeFileSync(join(cwd, 'baton.config.json'), JSON.stringify({
    schema: 'baton/config@1',
    roles: { planner: ['claude-code/claude-fable-5'], 'work-role': [] },
    platforms: { 'claude-code': {} },
    defaults: { 'claude-code': 'claude-fable-5' },
  }, null, 2));
  writeFileSync(join(cwd, 'loop.json'), JSON.stringify({
    schema: 'baton/loop@1', goal: 'detach e2e', constraints: [],
    smoke: { cmd: null, expect: null },
    budgets: { iterationCap: 5, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 },
    phases: [{ id: 'work', role: 'work-role' }],
  }, null, 2) + '\n');
  return cwd;
}

describe('loop run --detach — real detached supervisor (item 10 integration)', () => {
  it('RED (10 integration): the parent returns 0, a real detached child writes a bounded supervisor.out, and the lock releases on completion', { skip: SKIP_WIN }, async () => {
    const cwd = scratchRepo();
    const outPath = join(cwd, '.handoff', 'loop', 'supervisor.out');
    const lockPath = join(cwd, '.handoff', 'loop', 'supervisor.lock');

    const r = spawnSync(process.execPath, [bin, 'loop', 'run', '--detach'], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, `the parent returns 0 promptly; stderr: ${r.stderr}`);
    const pidMatch = r.stdout.match(/\b(\d{2,})\b/);
    if (pidMatch) spawnedPids.push(Number(pidMatch[1]));
    assert.match(r.stdout, /supervisor\.out/, 'the parent prints a tail hint for supervisor.out');

    // The real detached child writes its output to supervisor.out.
    assert.ok(await waitFor(() => existsSync(outPath)), 'the detached supervisor.out is created on real fs');
    // Bounded (a sane cap is never exceeded); exact truncation is the seam pin's domain.
    assert.ok(statSync(outPath).size <= 2 * 1024 * 1024, 'supervisor.out stays bounded (byte-capped, not unbounded)');

    // On the detached child's completion, the run lock is released.
    assert.ok(await waitFor(() => !existsSync(lockPath)), 'the run lock is released when the detached supervisor completes');
    // Sanity: the detached run reached a terminal state (parked on the ghost role).
    assert.ok(existsSync(join(cwd, '.handoff', 'loop', 'state.json')), 'the detached run persisted its state');
  });
});
