import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';

// ---------------------------------------------------------------------------
// RED — guarded worktree transaction layer (subtask worktrees). NEW module;
// these tests DEFINE the API. Everything is io-injected: git runs through
// io.execFile (a recording fake that REJECTS any unstubbed invocation, so a
// test must declare the exact command surface it expects), fs via memfs.
// Source of truth:
// docs/plans/2026-07-18-goal-loop-worktree-pipeline.md §"Worktree transaction
// layer (Gate-1 iteration 1, finding 5)" + §"Attribution enforcement for child
// commits (finding 6)" + acceptance constraints 3/5.
//
// TARGET MODULE: core/src/loop/worktrees.mjs.
//
// PINNED EXPORTS (the pipeline subtask consumes these):
//   WORKTREE_BRANCH_RE                       - /^baton\/wt-(a|b)\//
//   worktreePaths(root)                      - {dir, seats:{a,b}}  (…/.worktrees/wt-a|wt-b)
//   setupWorktrees(root, io)                 - Promise<{ok, worktrees:[{seat,path,branch}], gitignoreChanged}>
//   preflightWorktree(root, {seat, branch}, io)  - Promise<{ok:true} | {ok:false, check, refusal}>
//   postflightWorktree(root, {seat, branch, mainSha}, io) - Promise<{ok:true} | {ok:false, check, refusal}>
//   attributionScan(root, branch, io)        - Promise<{ok:true} | {ok:false, offending, reason}>
//   mergeSubtask(root, {branch}, io)         - Promise<{ok:true, …} | {ok:false, reason}>
//   selfHealWorktree(root, {seat, branch}, io) - Promise<{ok, healed}>
//   teardownWorktrees(root, io)              - Promise<{ok, removed:[…]}>
//   deleteBranch(root, branch, io)           - Promise<{ok:true} | {ok:false, error}> (branch jail)
//
// RED MECHANISM: dynamic-import-with-catch + M() guard (meaningful reds).
// ---------------------------------------------------------------------------

let mod = /** @type {any} */ (null);
let importError = /** @type {any} */ (null);
try {
  mod = await import('../../core/src/loop/worktrees.mjs');
} catch (e) {
  importError = e;
}
function M() {
  assert.ok(mod, `core/src/loop/worktrees.mjs must load (import error: ${importError?.message ?? 'none'})`);
  return mod;
}

const NAME = 'SakshamUboweja';
const EMAIL = 'ssakshamu@gmail.com';
const MAIN_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WT_A = '/repo/.worktrees/wt-a';
const WT_B = '/repo/.worktrees/wt-b';

// Any git subcommand that could mutate refs/worktrees/working-tree. On EVERY
// refusal path the full recorded call list must contain none of these.
const DESTRUCTIVE = /\b(branch\s+-[dD]\b|reset\b|clean\b|checkout\b|restore\b|rebase\b|merge\b|worktree\s+remove\b|push\b|commit\b)/;
function assertNoDestructiveGit(git, label) {
  const bad = git.git().filter((c) => DESTRUCTIVE.test(c.argstr));
  assert.deepEqual(bad.map((c) => c.argstr), [], `${label}: no destructive git may be issued on a refusal path`);
}

/**
 * A recording fake git. `responses` maps an args-substring (longest match wins)
 * to a canned result; { reject:true } models a nonzero git exit. An UNSTUBBED
 * git invocation REJECTS (ENOSTUB) — a test must declare its command surface.
 */
function fakeGit(responses = {}, lockProbe = null) {
  const keys = Object.keys(responses).sort((a, b) => b.length - a.length);
  const calls = /** @type {any[]} */ ([]);
  const fn = (/** @type {string} */ cmd, /** @type {string[]} */ args = [], /** @type {any} */ opts = {}) => {
    const argstr = args.join(' ');
    // Record whether the merge lock is present AT CALL TIME (finding 2): proves
    // mutating git ran under the acquired lock.
    calls.push({ cmd, args, argstr, cwd: opts?.cwd, lockPresent: typeof lockProbe === 'function' ? lockProbe() : undefined });
    if (cmd !== 'git') return Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    const k = keys.find((key) => argstr.includes(key));
    if (k === undefined) return Promise.reject(Object.assign(new Error(`unstubbed git: ${argstr}`), { code: 'ENOSTUB' }));
    const r = responses[k];
    if (r?.reject) return Promise.reject(Object.assign(new Error(r.stderr || 'git failed'), { code: r.code ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }));
    return Promise.resolve({ stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' });
  };
  fn.calls = calls;
  fn.git = () => calls.filter((c) => c.cmd === 'git');
  fn.issued = (/** @type {RegExp} */ re) => calls.some((c) => c.cmd === 'git' && re.test(c.argstr));
  fn.withCwd = (/** @type {RegExp} */ re, /** @type {string} */ cwd) => calls.filter((c) => c.cmd === 'git' && re.test(c.argstr) && c.cwd === cwd);
  fn.matching = (/** @type {RegExp} */ re) => calls.filter((c) => c.cmd === 'git' && re.test(c.argstr));
  return fn;
}

// A merge-scenario repo: io is built first so the fake git can probe the lock
// file at each call time.
const MERGE_LOCK = '/repo/.handoff/loop/merge.lock';
function mergeRepo(responses = {}, files = {}) {
  const io = makeIo({
    now: '2026-07-19T00:00:00.000Z',
    host: 'wt-host',
    pid: 4242,
    startTime: 111000,
    files: { '/repo/.git/HEAD': 'ref: refs/heads/main\n', ...files },
  });
  const git = fakeGit(responses, () => io.fs.existsSync(MERGE_LOCK));
  io.execFile = git;
  io.__git = git;
  return { io, git };
}

// git worktree list --porcelain output for the given entries.
function porcelain(entries) {
  return entries.map((e) => `worktree ${e.path}\nHEAD ${e.sha ?? MAIN_SHA}\nbranch refs/heads/${e.branch}\n`).join('\n');
}

function makeRepo({ git, files = {} } = {}) {
  const io = makeIo({
    now: '2026-07-19T00:00:00.000Z',
    host: 'wt-host',
    pid: 4242,
    startTime: 111000,
    files: { '/repo/.git/HEAD': 'ref: refs/heads/main\n', ...files },
  });
  if (git) io.execFile = git;
  io.__git = git;
  return io;
}

// The single declared attribution log format — the parser and every fixture
// derive from THIS constant so they cannot diverge (verifier iter-3 finding 1):
// per-commit fields NUL-delimited in this exact order, each record RS-terminated.
const LOG_FORMAT = '%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e';
// Field order MUST mirror LOG_FORMAT (sha, author-name, author-email,
// committer-name, committer-email, body); records RS(\x1e)-terminated as %x1e does.
const REC = (sha, an, ae, cn, ce, body) => [sha, an, ae, cn, ce, body].join('\x00');
const logStdout = (...recs) => recs.map((r) => r + '\x1e').join('');

// ===========================================================================
describe('worktrees — branch namespace', () => {
  it('the loop-owned branch namespace is baton/wt-(a|b)/…', () => {
    const { WORKTREE_BRANCH_RE } = M();
    assert.ok(WORKTREE_BRANCH_RE.test('baton/wt-a/subtask-3'));
    assert.ok(WORKTREE_BRANCH_RE.test('baton/wt-b/smoke'));
    assert.ok(!WORKTREE_BRANCH_RE.test('feature/x'));
    assert.ok(!WORKTREE_BRANCH_RE.test('baton/other/y'));
  });

  it('worktreePaths resolves the two seats under .worktrees/', () => {
    const { worktreePaths } = M();
    const p = worktreePaths('/repo');
    assert.equal(p.dir, '/repo/.worktrees');
    assert.equal(p.seats.a, WT_A);
    assert.equal(p.seats.b, WT_B);
  });
});

// ===========================================================================
describe('worktrees — setup transaction', () => {
  it('adds both seats on UNIQUE baton/wt-(a|b) branches at the expected paths; records {seat,path,branch}; ignores .worktrees/', async () => {
    const { setupWorktrees } = M();
    const git = fakeGit({
      'worktree list': { stdout: porcelain([{ path: '/repo', branch: 'main' }]) },
      'worktree add': { stdout: '' },
    });
    const io = makeRepo({ git, files: { '/repo/.gitignore': '.handoff/\n' } });

    const res = await setupWorktrees('/repo', io);
    assert.equal(res.ok, true);
    assert.equal(res.gitignoreChanged, true, 'the gitignore was updated');
    assert.match(io.files()['/repo/.gitignore'], /(^|\n)\.worktrees\/?\n/, '.worktrees/ is ignored');

    // Two setup records, one per seat, at the expected seat paths.
    const bySeat = Object.fromEntries((res.worktrees ?? []).map((w) => [w.seat, w]));
    assert.equal(bySeat.a?.path, WT_A);
    assert.equal(bySeat.b?.path, WT_B);
    assert.match(String(bySeat.a?.branch), /^baton\/wt-a\//);
    assert.match(String(bySeat.b?.branch), /^baton\/wt-b\//);
    assert.notEqual(bySeat.a.branch, bySeat.b.branch, 'the two seats get UNIQUE branches');

    const adds = git.git().filter((c) => c.argstr.startsWith('worktree add'));
    assert.equal(adds.length, 2, 'exactly two worktree adds');
    assert.ok(adds.some((c) => c.argstr.includes(WT_A) && /baton\/wt-a\//.test(c.argstr)), 'wt-a add uses its path + branch');
    assert.ok(adds.some((c) => c.argstr.includes(WT_B) && /baton\/wt-b\//.test(c.argstr)), 'wt-b add uses its path + branch');
  });

  it('is idempotent: a second setup with both worktrees present adds nothing', async () => {
    const { setupWorktrees } = M();
    const git = fakeGit({
      'worktree list': {
        stdout: porcelain([
          { path: '/repo', branch: 'main' },
          { path: WT_A, branch: 'baton/wt-a/base' },
          { path: WT_B, branch: 'baton/wt-b/base' },
        ]),
      },
    });
    const io = makeRepo({ git, files: { '/repo/.gitignore': '.handoff/\n.worktrees/\n', [`${WT_A}/.keep`]: '', [`${WT_B}/.keep`]: '' } });

    const res = await setupWorktrees('/repo', io);
    assert.equal(res.ok, true);
    assert.equal(git.git().filter((c) => c.argstr.startsWith('worktree add')).length, 0, 'no duplicate worktree add');
    assert.equal(res.gitignoreChanged, false, 'an already-covering .gitignore is a no-op');
  });
});

// ===========================================================================
describe('worktrees — preflight before a child (seat-cwd scoped)', () => {
  const listed = porcelain([
    { path: '/repo', branch: 'main' },
    { path: WT_A, branch: 'baton/wt-a/subtask-1' },
  ]);
  const P = { seat: 'a', branch: 'baton/wt-a/subtask-1' };

  it('passes when listed + clean + on the branch, and runs status/rev-parse in the SEAT cwd', async () => {
    const { preflightWorktree } = M();
    const git = fakeGit({
      'worktree list': { stdout: listed },
      'status --porcelain': { stdout: '' },
      'rev-parse --abbrev-ref HEAD': { stdout: 'baton/wt-a/subtask-1\n' },
    });
    const io = makeRepo({ git, files: { [`${WT_A}/.keep`]: '' } });
    const r = await preflightWorktree('/repo', P, io);
    assert.equal(r.ok, true);
    assert.equal(git.withCwd(/status --porcelain/, WT_A).length, 1, 'the clean-index check runs in the seat worktree');
    assert.equal(git.withCwd(/rev-parse --abbrev-ref HEAD/, WT_A).length, 1, 'the HEAD-branch check runs in the seat worktree');
  });

  it('a DIRTY index refuses (naming the check) and issues NO destructive git', async () => {
    const { preflightWorktree } = M();
    const git = fakeGit({
      'worktree list': { stdout: listed },
      'status --porcelain': { stdout: ' M src/x.js\n' },
      'rev-parse --abbrev-ref HEAD': { stdout: 'baton/wt-a/subtask-1\n' },
    });
    const io = makeRepo({ git, files: { [`${WT_A}/.keep`]: '' } });
    const r = await preflightWorktree('/repo', P, io);
    assert.equal(r.ok, false);
    assert.match(`${r.check} ${r.refusal}`, /dirty|clean|index/i, 'the refusal names the dirty-index check');
    assertNoDestructiveGit(git, 'preflight dirty');
  });

  it('a WRONG branch refuses naming the branch check', async () => {
    const { preflightWorktree } = M();
    const git = fakeGit({
      'worktree list': { stdout: listed },
      'status --porcelain': { stdout: '' },
      'rev-parse --abbrev-ref HEAD': { stdout: 'baton/wt-a/OTHER\n' },
    });
    const io = makeRepo({ git, files: { [`${WT_A}/.keep`]: '' } });
    const r = await preflightWorktree('/repo', P, io);
    assert.equal(r.ok, false);
    assert.match(`${r.check} ${r.refusal}`, /branch|HEAD/i, 'the refusal names the wrong-branch check');
    assertNoDestructiveGit(git, 'preflight wrong-branch');
  });

  it('a MISSING worktree refuses naming the missing check', async () => {
    const { preflightWorktree } = M();
    const git = fakeGit({ 'worktree list': { stdout: porcelain([{ path: '/repo', branch: 'main' }]) } });
    const io = makeRepo({ git });
    const r = await preflightWorktree('/repo', P, io);
    assert.equal(r.ok, false);
    assert.match(`${r.check} ${r.refusal}`, /missing|not.*(listed|found)|worktree/i, 'the refusal names the missing worktree');
    assertNoDestructiveGit(git, 'preflight missing');
  });
});

// ===========================================================================
describe('worktrees — postflight after a child (seat-cwd scoped)', () => {
  const P = { seat: 'a', branch: 'baton/wt-a/subtask-1', mainSha: MAIN_SHA };

  it('passes when HEAD is still on the branch (checked in the seat cwd) and main is unmoved', async () => {
    const { postflightWorktree } = M();
    const git = fakeGit({
      'rev-parse --abbrev-ref HEAD': { stdout: 'baton/wt-a/subtask-1\n' },
      'rev-parse main': { stdout: `${MAIN_SHA}\n` },
    });
    const io = makeRepo({ git });
    const r = await postflightWorktree('/repo', P, io);
    assert.equal(r.ok, true);
    assert.equal(git.withCwd(/rev-parse --abbrev-ref HEAD/, WT_A).length, 1, 'the HEAD check runs in the seat worktree');
  });

  it('refuses when MAIN moved under the child (naming what moved)', async () => {
    const { postflightWorktree } = M();
    const git = fakeGit({
      'rev-parse --abbrev-ref HEAD': { stdout: 'baton/wt-a/subtask-1\n' },
      'rev-parse main': { stdout: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' },
    });
    const io = makeRepo({ git });
    const r = await postflightWorktree('/repo', P, io);
    assert.equal(r.ok, false);
    assert.match(`${r.check} ${r.refusal}`, /main.*moved|main/i, 'the refusal names main moving');
    assertNoDestructiveGit(git, 'postflight main-moved');
  });

  it('refuses when HEAD drifted off the expected branch', async () => {
    const { postflightWorktree } = M();
    const git = fakeGit({
      'rev-parse --abbrev-ref HEAD': { stdout: 'detached\n' },
      'rev-parse main': { stdout: `${MAIN_SHA}\n` },
    });
    const io = makeRepo({ git });
    const r = await postflightWorktree('/repo', P, io);
    assert.equal(r.ok, false);
    assert.match(`${r.check} ${r.refusal}`, /branch|HEAD/i, 'the refusal names the HEAD drift');
    assertNoDestructiveGit(git, 'postflight head-drift');
  });
});

// ===========================================================================
describe('worktrees — attribution range scan (the merge gate)', () => {
  const BRANCH = 'baton/wt-a/subtask-1';
  const RANGE = `main..${BRANCH}`;
  const cleanLog = logStdout(REC('c1', NAME, EMAIL, NAME, EMAIL, 'subtask: add tests'), REC('c2', NAME, EMAIL, NAME, EMAIL, 'subtask: implement'));

  it('a clean range (sole author+committer, no forbidden trailers) passes', async () => {
    const { attributionScan } = M();
    const git = fakeGit({ [`log ${RANGE}`]: { stdout: cleanLog } });
    const io = makeRepo({ git });
    const r = await attributionScan('/repo', BRANCH, io);
    assert.equal(r.ok, true);
  });

  it('requests a NUL-field + RS-record log format carrying sha/author(name,email)/committer(name,email)/body over the FULL range (no last-N)', async () => {
    const { attributionScan } = M();
    const git = fakeGit({ [`log ${RANGE}`]: { stdout: cleanLog } });
    const io = makeRepo({ git });
    await attributionScan('/repo', BRANCH, io);
    const logCall = git.git().find((c) => c.argstr.startsWith('log '));
    assert.ok(logCall, 'a git log was issued');
    assert.match(logCall.argstr, new RegExp('main\\.\\.baton/wt-a/subtask-1'), 'the scan uses the exact range');
    // The EXACT order-preserving format the fixtures are built from — parser and
    // fixture derive from the one LOG_FORMAT constant, so they cannot diverge.
    assert.ok(logCall.argstr.includes(LOG_FORMAT), `the scan requests the exact format ${LOG_FORMAT}; got: ${logCall.argstr}`);
    assert.ok(!/\s-n\s|--max-count/.test(logCall.argstr), 'the scan is NOT bounded to a last-N window');
  });

  // Mismatch-only negatives — exactly one identity field wrong per case (finding 3).
  const IDENTITY_CASES = [
    ['author NAME', REC('id-an', 'Wrong Name', EMAIL, NAME, EMAIL, 'x'), /author|name|identity/i],
    ['author EMAIL', REC('id-ae', NAME, 'wrong@x.z', NAME, EMAIL, 'x'), /author|email|identity/i],
    ['committer NAME', REC('id-cn', NAME, EMAIL, 'Wrong CN', EMAIL, 'x'), /committer|name|identity/i],
    ['committer EMAIL', REC('id-ce', NAME, EMAIL, NAME, 'wrong@x.z', 'x'), /committer|email|identity/i],
  ];
  for (const [label, rec, reasonRe] of IDENTITY_CASES) {
    it(`a mismatched ${label} (all other identity fields valid) blocks, naming the offending commit`, async () => {
      const { attributionScan } = M();
      const git = fakeGit({ [`log ${RANGE}`]: { stdout: logStdout(rec) } });
      const io = makeRepo({ git });
      const r = await attributionScan('/repo', BRANCH, io);
      assert.equal(r.ok, false, `a mismatched ${label} must block`);
      assert.match(String(r.offending), new RegExp(String(rec).split('\x00')[0]), 'names the offending commit');
      assert.match(String(r.reason), reasonRe, `the reason names the ${label} violation`);
      assertNoDestructiveGit(git, `attribution ${label}`);
    });
  }

  it('a foreign AUTHOR blocks, naming the offending commit', async () => {
    const { attributionScan } = M();
    const bad = logStdout(REC('c1', NAME, EMAIL, NAME, EMAIL, 'ok'), REC('deadbeef', 'Someone Else', 'else@example.com', NAME, EMAIL, 'sneaky'));
    const git = fakeGit({ [`log ${RANGE}`]: { stdout: bad } });
    const io = makeRepo({ git });
    const r = await attributionScan('/repo', BRANCH, io);
    assert.equal(r.ok, false);
    assert.match(String(r.offending), /deadbeef/, 'the refusal names the offending commit');
    assert.match(String(r.reason), /author|identity/i, 'the reason names the identity violation');
    assertNoDestructiveGit(git, 'attribution foreign-author');
  });

  it('a foreign COMMITTER (author valid) also blocks — both identities are checked', async () => {
    const { attributionScan } = M();
    const bad = logStdout(REC('cmtr01', NAME, EMAIL, 'Rebase Bot', 'bot@ci.example', 'valid author, foreign committer'));
    const git = fakeGit({ [`log ${RANGE}`]: { stdout: bad } });
    const io = makeRepo({ git });
    const r = await attributionScan('/repo', BRANCH, io);
    assert.equal(r.ok, false);
    assert.match(String(r.offending), /cmtr01/, 'names the offending commit');
    assert.match(String(r.reason), /committer|identity/i, 'the reason names the committer violation');
    assertNoDestructiveGit(git, 'attribution foreign-committer');
  });

  // Forbidden-trailer positives mirroring core/src/commands/doctor.mjs TRAILER_PATTERNS.
  const TRAILER_CASES = [
    ['Co-Authored-By (claude)', 'implement\n\nCo-Authored-By: Claude <noreply@anthropic.com>'],
    ['generated-with (claude)', 'implement\n\n🤖 Generated with Claude Code'],
    ['robot emoji', 'implement\n\nshipped \u{1F916}'],
  ];
  for (const [label, body] of TRAILER_CASES) {
    it(`a forbidden trailer blocks: ${label}`, async () => {
      const { attributionScan } = M();
      const git = fakeGit({ [`log ${RANGE}`]: { stdout: logStdout(REC('tc1', NAME, EMAIL, NAME, EMAIL, body)) } });
      const io = makeRepo({ git });
      const r = await attributionScan('/repo', BRANCH, io);
      assert.equal(r.ok, false, `${label} must block the merge`);
      assert.match(String(r.reason), /trailer|attribution|generated|co-authored|emoji/i, 'the reason names the forbidden trailer');
      assertNoDestructiveGit(git, `attribution trailer ${label}`);
    });
  }
});

// ===========================================================================
describe('worktrees — merge transaction', () => {
  const BRANCH = 'baton/wt-a/subtask-1';
  const RANGE = `main..${BRANCH}`;
  const cleanLog = logStdout(REC('c1', NAME, EMAIL, NAME, EMAIL, 'clean'));

  it('refuses to merge while a merge-lock is held (no destructive git at all), leaving the owner lock intact', async () => {
    const { mergeSubtask } = M();
    const held = JSON.stringify({ host: 'wt-host', pid: 55555 });
    const { io, git } = mergeRepo({}, { [MERGE_LOCK]: held }); // any stubbed git call would be a violation
    const r = await mergeSubtask('/repo', { branch: BRANCH }, io);
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /lock|held|merge/i, 'the refusal names the held merge lock');
    assertNoDestructiveGit(git, 'held-lock refusal');
    assert.equal(io.files()[MERGE_LOCK], held, "another owner's lock is left intact");
  });

  it('a merge CONFLICT aborts (git merge --abort), parks, and RELEASES the lock', async () => {
    const { mergeSubtask } = M();
    const { io, git } = mergeRepo({
      [`log ${RANGE}`]: { stdout: cleanLog },
      [`merge ${BRANCH}`]: { reject: true, code: 1, stdout: 'CONFLICT (content): Merge conflict in src/x.js\nAutomatic merge failed' },
      'merge --abort': { stdout: '' },
    });
    const r = await mergeSubtask('/repo', { branch: BRANCH }, io);
    assert.equal(r.ok, false);
    // The conflicting merge ran at the repo root, under the acquired lock.
    const merges = git.matching(new RegExp(`^merge ${BRANCH.replace(/\//g, '\\/')}$`));
    assert.equal(merges.length, 1, 'exactly one merge attempt');
    assert.equal(merges[0].cwd, '/repo', 'the merge ran at the repo root');
    assert.equal(merges[0].lockPresent, true, 'the merge ran under the acquired lock');
    // The abort also ran at the repo root, still under the lock.
    const aborts = git.matching(/^merge --abort$/);
    assert.equal(aborts.length, 1, 'the conflicted merge is aborted exactly once');
    assert.equal(aborts[0].cwd, '/repo', 'the abort runs at the repo root (where the merge happened)');
    assert.equal(aborts[0].lockPresent, true, 'the abort runs under the acquired lock');
    assert.match(String(r.reason), /conflict|park/i, 'the result is a park-shaped refusal');
    assert.ok(!git.issued(/commit|-X (ours|theirs)|checkout --theirs/), 'no auto-resolution was attempted');
    assert.ok(!io.fs.existsSync(MERGE_LOCK), 'the merge lock is released after the conflict abort');
  });

  it('a clean merge runs `merge <branch>` in /repo UNDER the lock, ff-syncs `merge --ff-only main` once per seat cwd (also under the lock), releases the lock', async () => {
    const { mergeSubtask } = M();
    const { io, git } = mergeRepo({
      [`log ${RANGE}`]: { stdout: cleanLog },
      [`merge ${BRANCH}`]: { stdout: 'Updating; Fast-forward' },
      'merge --ff-only main': { stdout: 'Already up to date.' },
    });
    const r = await mergeSubtask('/repo', { branch: BRANCH }, io);
    assert.equal(r.ok, true);

    // The merge itself: exactly one, in /repo, while the lock is held.
    const merges = git.matching(new RegExp(`^merge ${BRANCH.replace(/\//g, '\\/')}$`));
    assert.equal(merges.length, 1, 'exactly one merge of the subtask branch');
    assert.equal(merges[0].cwd, '/repo', 'the merge into main runs at the repo root');
    assert.equal(merges[0].lockPresent, true, 'the merge ran under the acquired lock');

    // ff-only sync: EXACTLY 'merge --ff-only main' (anchored, no trailing tokens),
    // once per seat cwd, under the lock.
    const ffA = git.withCwd(/^merge --ff-only main$/, WT_A);
    const ffB = git.withCwd(/^merge --ff-only main$/, WT_B);
    assert.equal(ffA.length, 1, 'wt-a fast-forwards to main in its own cwd');
    assert.equal(ffB.length, 1, 'wt-b fast-forwards to main in its own cwd');
    assert.equal(git.matching(/^merge --ff-only/).length, 2, 'exactly two ff-only syncs, one per seat');
    assert.ok(ffA[0].lockPresent && ffB[0].lockPresent, 'the ff-only syncs ran under the acquired lock');

    assert.ok(!io.fs.existsSync(MERGE_LOCK), 'the merge lock is released after a successful merge');
  });

  it('a NON-fast-forward worktree sync is a corruption signal → refusal, and RELEASES the lock', async () => {
    const { mergeSubtask } = M();
    const { io } = mergeRepo({
      [`log ${RANGE}`]: { stdout: cleanLog },
      [`merge ${BRANCH}`]: { stdout: 'Fast-forward' },
      'merge --ff-only main': { reject: true, code: 1, stderr: 'fatal: Not possible to fast-forward, aborting.' },
    });
    const r = await mergeSubtask('/repo', { branch: BRANCH }, io);
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /fast-forward|ff|corrupt|sync/i, 'a non-ff sync refuses as corruption');
    assert.ok(!io.fs.existsSync(MERGE_LOCK), 'the merge lock is released on a non-ff refusal');
  });

  it('an attribution violation BLOCKS the merge (no destructive git) and RELEASES the lock', async () => {
    const { mergeSubtask } = M();
    const bad = logStdout(REC('badc0de', 'Someone Else', 'x@y.z', NAME, EMAIL, 'sneaky'));
    const { io, git } = mergeRepo({ [`log ${RANGE}`]: { stdout: bad } });
    const r = await mergeSubtask('/repo', { branch: BRANCH }, io);
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /author|attribution|identity/i, 'the merge is gated on the attribution scan');
    assertNoDestructiveGit(git, 'attribution-block refusal');
    assert.ok(!io.fs.existsSync(MERGE_LOCK), 'the merge lock is released even when attribution blocks after acquisition');
  });
});

// ===========================================================================
describe('worktrees — self-heal and teardown', () => {
  it('a raw-deleted worktree dir (listed by git, missing on fs) is pruned then re-added', async () => {
    const { selfHealWorktree } = M();
    const git = fakeGit({
      'worktree list': { stdout: porcelain([{ path: '/repo', branch: 'main' }, { path: WT_A, branch: 'baton/wt-a/base' }]) },
      'worktree prune': { stdout: '' },
      'worktree add': { stdout: '' },
    });
    const io = makeRepo({ git }); // no files under WT_A -> fs says it is gone
    const r = await selfHealWorktree('/repo', { seat: 'a', branch: 'baton/wt-a/base' }, io);
    assert.equal(r.healed, true);
    assert.ok(git.issued(/worktree prune/), 'the stale metadata is pruned');
    assert.ok(git.issued(/worktree add/), 'the worktree is re-added');
  });

  it('teardown removes worktrees + deletes ONLY baton/wt- branches, never a non-baton branch', async () => {
    const { teardownWorktrees } = M();
    const git = fakeGit({
      'worktree list': {
        stdout: porcelain([
          { path: '/repo', branch: 'main' },
          { path: WT_A, branch: 'baton/wt-a/base' },
          { path: WT_B, branch: 'baton/wt-b/base' },
          { path: '/repo/.worktrees/other', branch: 'feature/keep-me' },
        ]),
      },
      'worktree remove': { stdout: '' },
      'branch -D': { stdout: '' },
    });
    const io = makeRepo({ git });
    const r = await teardownWorktrees('/repo', io);
    assert.equal(r.ok, true);

    // Exactly the two seat worktrees are removed — never the non-baton one.
    const removes = git.matching(/worktree remove/).map((c) => c.argstr);
    assert.ok(removes.some((s) => s.includes(WT_A)), 'wt-a worktree removed');
    assert.ok(removes.some((s) => s.includes(WT_B)), 'wt-b worktree removed');
    assert.equal(removes.length, 2, 'exactly two worktree removes — the non-baton worktree is untouched');
    assert.ok(!removes.some((s) => /other/.test(s)), 'a non-baton worktree is never removed');

    // Exactly the two listed baton branches are deleted — no extras.
    const deleted = git.matching(/branch -D/).map((c) => c.argstr);
    assert.ok(deleted.some((s) => /branch -D baton\/wt-a\/base\b/.test(s)), 'baton/wt-a/base deleted');
    assert.ok(deleted.some((s) => /branch -D baton\/wt-b\/base\b/.test(s)), 'baton/wt-b/base deleted');
    assert.equal(deleted.length, 2, 'exactly two branch deletions — no extra deletions');
    assert.ok(!deleted.some((s) => /feature\/keep-me/.test(s)), 'a non-baton branch is never deleted');

    // The result records both seats.
    assert.deepEqual([...(r.removed ?? [])].sort(), ['a', 'b'], 'res.removed contains both seats');
  });
});

// ===========================================================================
describe('worktrees — branch jail', () => {
  it('deleteBranch refuses a branch outside the baton/wt- namespace (no git at all)', async () => {
    const { deleteBranch } = M();
    const git = fakeGit({}); // any git call would reject (ENOSTUB) and fail the test
    const io = makeRepo({ git });
    const r = await deleteBranch('/repo', 'feature/important', io);
    assert.equal(r.ok, false);
    assert.match(String(r.error), /baton\/wt-|namespace|refus/i, 'the jail names the namespace requirement');
    assert.ok(!git.issued(/branch -[dD]/), 'no branch deletion is issued for an out-of-namespace branch');
    assertNoDestructiveGit(git, 'branch-jail refusal');
  });

  it('deleteBranch issues git branch -D for an in-namespace branch', async () => {
    const { deleteBranch } = M();
    const git = fakeGit({ 'branch -D': { stdout: '' } });
    const io = makeRepo({ git });
    const r = await deleteBranch('/repo', 'baton/wt-a/subtask-1', io);
    assert.equal(r.ok, true);
    assert.ok(git.issued(/branch -D baton\/wt-a\/subtask-1/), 'a namespaced branch is deleted');
  });
});
