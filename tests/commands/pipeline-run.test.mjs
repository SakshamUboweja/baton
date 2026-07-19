import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { run } from '../../core/src/cli.mjs';
import { loadLoopState, loopPaths, LOOP_STATUS } from '../../core/src/loop/state.mjs';
import { dedupeKey } from '../../core/src/util/ids.mjs';

// ---------------------------------------------------------------------------
// RED — `baton pipeline run` (subtask pipeline, Layer 3). NEW command that
// COMPOSES worktrees/children/state/failover into the dual-worktree per-subtask
// cadence with a per-subtask seat swap; the merger role performs the final
// adversarial merge (via the REAL mergeSubtask machinery — the merger CHILD
// never merges). Source: plan §"baton pipeline (Layer 3 — a loop preset)".
//
// TARGET: core/src/commands/pipeline.mjs (+ cli.mjs routing for 'pipeline').
// Driven through the real router run(['pipeline', …], io). Today 'pipeline' is
// not a known command, so run() exits 2 ("unknown command 'pipeline'"); reds
// assert TARGET behavior — distinguished from that generic exit 2.
//
// SEAMS (same as loop run): io.superviseChild (fake scripted runner recording
// {command,args,env,opts}), io.execFile (STRICT fake git — unstubbed rejects),
// io.processAlive. --detach is out of unit scope (deferred to e2e).
//
// PINNED EXIT CODES (shared with loop run): done 0 · escalated 3 · parked 4 ·
// usage error 2.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const SIG_ABS = join(repoRoot, 'core', 'data', 'signatures.v1.json');
const SIG_CONTENT = nodeFs.readFileSync(SIG_ABS, 'utf8');

const T0 = '2026-07-19T00:00:00.000Z';
const NAME = 'SakshamUboweja';
const EMAIL = 'ssakshamu@gmail.com';
const MAIN_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WT_A = '/repo/.worktrees/wt-a';
const WT_B = '/repo/.worktrees/wt-b';
const MERGE_LOCK = '/repo/.handoff/loop/merge.lock';
const CC_LIMIT = "You've hit your session limit · resets 3pm"; // claude-code usage-limit signature
const CODEX_LIMIT = "You've hit your usage limit"; // codex usage-limit signature
const MODEL_UNAVAIL = 'not supported when using Codex with a ChatGPT account'; // codex model-unavailable signature

// Both seats codex so --model is present in every child argv (claude-code omits
// it), letting the tests assert per-seat models directly.
const PIPELINE_CONFIG = {
  schema: 'baton/config@1',
  roles: {
    planner: ['codex/planner-m@xhigh'],
    merger: ['codex/mg-model@xhigh'],
    'worker-a': ['codex/wa-model@xhigh'],
    'worker-b': ['codex/wb-model@xhigh'],
    'subtask-reviewer': ['codex/sr-model@xhigh'],
    'test-author': ['codex/ta@xhigh'],
    'test-verifier': ['codex/tv@xhigh'],
    implementer: ['codex/impl@xhigh'],
    'plan-reviewer': ['codex/pr@xhigh'],
    'final-reviewer-a': ['codex/fra@xhigh'],
    'final-reviewer-b': ['codex/frb@xhigh'],
  },
  platforms: { 'claude-code': {}, codex: {}, cursor: {} },
  defaults: { 'claude-code': 'claude-fable-5', codex: 'gpt-5.6-sol', cursor: 'composer' },
};

const pipelineSpec = (over = {}) => ({
  schema: 'baton/loop@1',
  goal: 'Ship the pipeline',
  constraints: [],
  budgets: { iterationCap: 5, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 },
  subtasks: [
    { id: 't1', title: 'First subtask' },
    { id: 't2', title: 'Second subtask' },
  ],
  ...over,
});

const REC = (sha, an, ae, cn, ce, body) => [sha, an, ae, cn, ce, body].join('\x00');
const logStdout = (...recs) => recs.map((r) => r + '\x1e').join('');
const CLEAN_LOG = logStdout(REC('c1', NAME, EMAIL, NAME, EMAIL, 'subtask work'));

// A seeded handoff bundle so a pipeline writer limit-death has a real bundle to
// seal/receive through runFailover.
function ownedBundle(originPlatform = 'claude-code', status = 'open') {
  return {
    schema: 'baton/bundle@1',
    bundleId: 'b_pipe00000000000',
    generation: 1,
    createdAt: T0,
    updatedAt: T0,
    origin: { platform: originPlatform, model: 'm', sessionHint: 'loop-sup', unstable: false },
    task: { goal: 'Ship the pipeline', constraints: [], acceptance: [] },
    plan: { steps: [] },
    decisions: [],
    files: { touched: [] },
    roles: { assignments: {} },
    git: null,
    handoff:
      status === 'sealed'
        ? { status: 'sealed', reason: 'seal', reasonClass: 'usage-limit', toPlatformHint: null, finalizedAt: T0, receive_log: [] }
        : { status: 'open', reason: null, reasonClass: null, toPlatformHint: null, finalizedAt: null, receive_log: [] },
    journalSeq: 0,
    compaction: { droppedDecisions: 0, note: null },
    dedupeRing: [],
  };
}

/**
 * A STRICT, stateful fake git: unstubbed commands reject; worktree add/list and
 * checkout -b are modeled so setup + preflight/postflight + merge cohere.
 * `over` overrides specific responses (e.g. a merge conflict).
 */
function pipelineGit({ over = {}, log = CLEAN_LOG, existingBranches = [], dirtyCwds = [], mergedBranches = [] } = {}) {
  const added = /** @type {Map<string,string>} */ (new Map()); // path -> branch
  const branchAt = /** @type {Map<string,string>} */ (new Map()); // cwd -> current branch
  const branches = new Set(existingBranches); // stale/pre-existing namespaced branches
  const dirty = new Set(dirtyCwds); // seat cwds whose index is dirty
  const deleted = new Set(); // seats listed by git but raw-deleted on disk
  const merged = new Set(mergedBranches); // branches already merged into main (ancestor; empty main..branch)
  const calls = /** @type {any[]} */ ([]);
  const lockProbeRef = { fn: /** @type {null | (() => boolean)} */ (null) };
  let mainSha = MAIN_SHA; // mutable so a child can "move main" mid-subtask

  const list = () => {
    const entries = [{ path: '/repo', branch: 'main' }];
    for (const [path, branch] of added) entries.push({ path, branch: branchAt.get(path) ?? branch });
    return entries.map((e) => `worktree ${e.path}\nHEAD ${MAIN_SHA}\nbranch refs/heads/${e.branch}\n`).join('\n');
  };

  const fn = (/** @type {string} */ cmd, /** @type {string[]} */ args = [], /** @type {any} */ opts = {}) => {
    const argstr = args.join(' ');
    calls.push({ cmd, args, argstr, cwd: opts?.cwd, lockPresent: lockProbeRef.fn ? lockProbeRef.fn() : undefined });
    if (cmd !== 'git') return Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

    // Explicit overrides win.
    const okey = Object.keys(over).sort((a, b) => b.length - a.length).find((k) => argstr.includes(k));
    if (okey) {
      const r = over[okey];
      if (r?.reject) return Promise.reject(Object.assign(new Error(r.stderr || 'git failed'), { code: r.code ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }));
      return Promise.resolve({ stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' });
    }

    // A raw-deleted seat: git still LISTS it, but any command IN that cwd fails
    // (the directory is gone). Only self-heal (prune + re-add) recovers it.
    if (opts?.cwd && deleted.has(opts.cwd) && !argstr.startsWith('worktree ')) {
      return Promise.reject(Object.assign(new Error(`fatal: cannot chdir to '${opts.cwd}': No such file or directory`), { code: 128, stderr: 'No such file or directory\n' }));
    }
    if (argstr.startsWith('worktree list')) return Promise.resolve({ stdout: list(), stderr: '' });
    if (argstr.startsWith('worktree add')) {
      const path = args.find((a) => a.startsWith('/repo/.worktrees/'));
      const bi = args.indexOf('-b');
      const branch = bi >= 0 ? args[bi + 1] : 'baton/wt-x/base';
      if (path) { added.set(path, branch); branchAt.set(path, branch); deleted.delete(path); }
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    if (argstr.startsWith('worktree prune')) { deleted.clear(); return Promise.resolve({ stdout: '', stderr: '' }); }
    if (argstr.startsWith('worktree remove')) return Promise.resolve({ stdout: '', stderr: '' });
    if (argstr.startsWith('checkout -b')) {
      const target = args[args.indexOf('-b') + 1];
      if (branches.has(target)) return Promise.reject(Object.assign(new Error(`fatal: a branch named '${target}' already exists`), { code: 128, stderr: `fatal: a branch named '${target}' already exists\n` }));
      branches.add(target);
      if (opts?.cwd) branchAt.set(opts.cwd, target);
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    if (argstr.startsWith('status --porcelain')) return Promise.resolve({ stdout: dirty.has(opts?.cwd) ? ' M dirty.txt\n' : '', stderr: '' });
    if (argstr === 'rev-parse --abbrev-ref HEAD') return Promise.resolve({ stdout: `${branchAt.get(opts?.cwd) ?? 'main'}\n`, stderr: '' });
    if (argstr.startsWith('rev-parse')) return Promise.resolve({ stdout: `${mainSha}\n`, stderr: '' });
    // merge-base --is-ancestor <branch> main : exit 0 iff <branch> is already in main.
    if (argstr.startsWith('merge-base --is-ancestor')) {
      const b = args[args.indexOf('--is-ancestor') + 1];
      return merged.has(b) ? Promise.resolve({ stdout: '', stderr: '' }) : Promise.reject(Object.assign(new Error('not an ancestor'), { code: 1, stdout: '', stderr: '' }));
    }
    if (argstr.startsWith('log ')) {
      // A merged branch has NO commits ahead of main (empty main..<branch>).
      const range = args.find((a) => /\.\./.test(String(a))) ?? '';
      const branch = String(range).split('..')[1];
      if (branch && merged.has(branch)) return Promise.resolve({ stdout: '', stderr: '' });
      return Promise.resolve({ stdout: log, stderr: '' });
    }
    if (argstr.startsWith('merge')) return Promise.resolve({ stdout: 'Fast-forward', stderr: '' });
    if (argstr.startsWith('branch -D')) return Promise.resolve({ stdout: '', stderr: '' });
    return Promise.reject(Object.assign(new Error(`unstubbed git: ${argstr}`), { code: 'ENOSTUB' }));
  };
  fn.calls = calls;
  fn.git = () => calls.filter((c) => c.cmd === 'git');
  fn.issued = (/** @type {RegExp} */ re) => calls.some((c) => c.cmd === 'git' && re.test(c.argstr));
  fn.matching = (/** @type {RegExp} */ re) => calls.filter((c) => c.cmd === 'git' && re.test(c.argstr));
  fn.withCwd = (/** @type {RegExp} */ re, /** @type {string} */ cwd) => calls.filter((c) => c.cmd === 'git' && re.test(c.argstr) && c.cwd === cwd);
  fn.setLockProbe = (/** @type {() => boolean} */ f) => { lockProbeRef.fn = f; };
  fn.moveMain = (/** @type {string} */ sha) => { mainSha = sha; }; // a child "moves main" mid-subtask
  fn.setBranch = (/** @type {string} */ cwd, /** @type {string} */ branch) => { branchAt.set(cwd, branch); };
  // Explicit seed: git LISTS this worktree; `raw` marks its dir as deleted on
  // disk (any in-cwd command fails until prune + re-add self-heals it).
  fn.seedWorktree = (/** @type {string} */ path, /** @type {string} */ branch, /** @type {{raw?: boolean}} */ o = {}) => {
    added.set(path, branch);
    branchAt.set(path, branch);
    if (o.raw) deleted.add(path);
  };
  return fn;
}

function fakeRunner(io, script) {
  const queue = [...script];
  const calls = /** @type {any[]} */ ([]);
  const fn = (/** @type {any} */ spec, /** @type {any} */ opts = {}) => {
    calls.push({ spec, opts, command: spec?.command, args: spec?.args ?? [], env: spec?.env });
    const r = queue.shift() ?? { verdict: 'APPROVED' };
    if (typeof r.logContent === 'string' && opts.logPath) {
      const dir = opts.logPath.slice(0, opts.logPath.lastIndexOf('/'));
      io.fs.mkdirSync(dir, { recursive: true });
      io.fs.writeFileSync(opts.logPath, r.logContent);
    }
    // A child may perturb the world (e.g. move main) between spawn and postflight.
    if (typeof r.effect === 'function') r.effect();
    return Promise.resolve({ timedOut: false, exitCode: r.exitCode ?? 0, verdict: r.verdict ?? 'APPROVED', findings: r.findings ?? '', logPath: opts.logPath });
  };
  fn.calls = calls;
  return fn;
}

function makePipeRepo({ spec = pipelineSpec(), config = PIPELINE_CONFIG, files = {}, git, runner, env = {} } = {}) {
  const io = makeIo({
    now: T0,
    host: 'pipe-host',
    pid: 4242,
    startTime: 111000,
    env,
    files: {
      [SIG_ABS]: SIG_CONTENT,
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/repo/baton.config.json': JSON.stringify(config, null, 2),
      ...(spec ? { '/repo/loop.json': JSON.stringify(spec, null, 2) + '\n' } : {}),
      ...files,
    },
  });
  const g = git ?? pipelineGit();
  g.setLockProbe(() => io.fs.existsSync(MERGE_LOCK));
  io.execFile = g;
  const fake = runner ?? fakeRunner(io, []);
  io.superviseChild = fake;
  io.__git = g;
  io.__runner = fake;
  return io;
}

// A full clean subtask = writer APPROVED, reviewer APPROVED, merger APPROVED.
const cleanSubtask = () => [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }, { verdict: 'APPROVED' }];
const argsOf = (call) => (call?.args ?? []).map(String);
const valAfter = (arr, flag) => { const i = arr.indexOf(flag); return i >= 0 ? arr[i + 1] : undefined; };
const childWithModel = (runner, model) => runner.calls.filter((c) => argsOf(c).includes(model));
// Writers = the write-capable children (in call order). Reviewers = read-only
// children whose prompt carries the 'subtask-reviewer' role identity (so the
// merger, also read-only, is excluded).
const writersOf = (runner) => runner.calls.filter((c) => valAfter(argsOf(c), '-s') === 'workspace-write');
const reviewersOf = (runner) => runner.calls.filter((c) => valAfter(argsOf(c), '-s') === 'read-only' && argsOf(c).join(' ').includes('subtask-reviewer'));

// ===========================================================================
describe('pipeline — CLI routing & flags', () => {
  it('no subcommand -> usage error (exit 2) naming a subcommand, not "unknown command"', async () => {
    const io = makePipeRepo();
    const code = await run(['pipeline'], io);
    assert.equal(code, 2);
    const out = io.stderrText() + io.stdoutText();
    assert.match(out, /subcommand|run/i, 'the error guides toward a subcommand');
    assert.doesNotMatch(out, /unknown command/i, 'pipeline IS a known command');
  });

  it('an unknown subcommand exits 2 naming it', async () => {
    const io = makePipeRepo();
    const code = await run(['pipeline', 'frobnicate'], io);
    assert.equal(code, 2);
    assert.match(io.stderrText() + io.stdoutText(), /frobnicate/, 'the error names the bad subcommand');
  });

  it('a stray positional / unknown flag exits 2 with zero spawns', async () => {
    const io1 = makePipeRepo();
    assert.equal(await run(['pipeline', 'run', 'stray'], io1), 2);
    assert.equal(io1.__runner.calls.length, 0, 'a garbled invocation spawns nothing');
    const io2 = makePipeRepo();
    assert.equal(await run(['pipeline', 'run', '--no-such-flag'], io2), 2);
    assert.equal(io2.__runner.calls.length, 0, 'an unknown flag spawns nothing');
  });

  it('BATON_SUPERVISED_CHILD does NOT suppress pipeline run (supervisor-side)', async () => {
    const io = makePipeRepo({ env: { BATON_SUPERVISED_CHILD: '1' }, runner: undefined });
    io.superviseChild = fakeRunner(io, [...cleanSubtask(), ...cleanSubtask()]);
    io.__runner = io.superviseChild;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 0, 'the guard is child-only; the supervisor command still runs');
    assert.ok(io.__runner.calls.length >= 1, 'children spawned under the guard env');
  });
});

// ===========================================================================
describe('pipeline — preconditions', () => {
  it('no loop.json -> exit 2 naming loop.json, zero spawns', async () => {
    const io = makePipeRepo({ spec: null });
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 2);
    const out = io.stderrText() + io.stdoutText();
    assert.match(out, /loop\.json/i, 'the error names the missing spec file');
    assert.doesNotMatch(out, /unknown command/i, 'pipeline is routed — the error is about the missing spec, not the command');
    assert.equal(io.__runner.calls.length, 0, 'no child spawned');
  });

  it('missing / empty subtasks -> exit 2 naming subtasks, zero spawns', async () => {
    for (const spec of [pipelineSpec({ subtasks: undefined }), pipelineSpec({ subtasks: [] })]) {
      const io = makePipeRepo({ spec });
      const code = await run(['pipeline', 'run'], io);
      assert.equal(code, 2, 'a pipeline needs subtasks');
      assert.match(io.stderrText() + io.stdoutText(), /subtasks/i, 'the error names subtasks');
      assert.equal(io.__runner.calls.length, 0, 'no child spawned without subtasks');
    }
  });

  it('malformed subtask items exit 2 naming the offender, with zero spawns', async () => {
    const CASES = [
      ['missing id', [{ title: 'no id' }], /id/i],
      ['missing title', [{ id: 't1' }], /title/i],
      ['non-string id', [{ id: 7, title: 'ok' }], /id/i],
      ['non-string title', [{ id: 't1', title: 5 }], /title/i],
      ['duplicate ids', [{ id: 't1', title: 'a' }, { id: 't1', title: 'b' }], /duplicate|t1/i],
    ];
    for (const [label, subtasks, needle] of CASES) {
      const io = makePipeRepo({ spec: pipelineSpec({ subtasks }) });
      const code = await run(['pipeline', 'run'], io);
      assert.equal(code, 2, `${label} is a usage error`);
      assert.match(io.stderrText() + io.stdoutText(), needle, `${label}: the error names the offender`);
      assert.equal(io.__runner.calls.length, 0, `${label}: zero spawns`);
    }
  });

  it('setupWorktrees runs before subtask 1 (worktree adds recorded) and only once', async () => {
    const io = makePipeRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [...cleanSubtask(), ...cleanSubtask()]);
    io.__runner = io.superviseChild;
    await run(['pipeline', 'run'], io);
    const adds = io.__git.matching(/^worktree add/);
    assert.equal(adds.length, 2, 'both seat worktrees are added exactly once, before the subtask cycle');
    assert.ok(adds.some((c) => c.argstr.includes(WT_A)) && adds.some((c) => c.argstr.includes(WT_B)), 'wt-a and wt-b are set up');
  });
});

// ===========================================================================
describe('pipeline — seat alternation (writer)', () => {
  it('subtask 1 writes in wt-a on baton/wt-a/subtask-t1 (worker-a model); subtask 2 writes in wt-b on baton/wt-b/subtask-t2 (worker-b model)', async () => {
    const io = makePipeRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [...cleanSubtask(), ...cleanSubtask()]);
    io.__runner = io.superviseChild;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 0);

    // Branch creation recorded in each seat's own cwd.
    assert.equal(io.__git.withCwd(/^checkout -b baton\/wt-a\/subtask-t1$/, WT_A).length, 1, 'subtask 1 branch created in wt-a');
    assert.equal(io.__git.withCwd(/^checkout -b baton\/wt-b\/subtask-t2$/, WT_B).length, 1, 'subtask 2 branch created in wt-b');

    // The WRITERS are exactly the two write-capable children, in subtask order —
    // isolating by -s workspace-write means a read-only reviewer can never
    // satisfy this (finding 1).
    const writers = writersOf(io.__runner);
    assert.equal(writers.length, 2, 'exactly two writer children (one per subtask)');
    assert.equal(valAfter(argsOf(writers[0]), '--model'), 'wa-model', 'subtask 1 writer uses the worker-a model');
    assert.equal(valAfter(argsOf(writers[0]), '-C'), WT_A, 'subtask 1 writer works in wt-a');
    assert.equal(valAfter(argsOf(writers[1]), '--model'), 'wb-model', 'subtask 2 writer uses the worker-b model');
    assert.equal(valAfter(argsOf(writers[1]), '-C'), WT_B, 'subtask 2 writer works in wt-b');
  });
});

// ===========================================================================
describe('pipeline — reviewer seat (read-only, other seat)', () => {
  it("both reviewers, in order: t1 = wb-model/WT_B/read-only, t2 = wa-model/WT_A/read-only, each under the subtask-reviewer role", async () => {
    const io = makePipeRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [...cleanSubtask(), ...cleanSubtask()]);
    io.__runner = io.superviseChild;
    await run(['pipeline', 'run'], io);

    const reviewers = reviewersOf(io.__runner);
    assert.equal(reviewers.length, 2, 'exactly two reviewer children (one per subtask), provable via the subtask-reviewer role identity in the prompt');
    // t1 reviewer: OTHER seat is b -> wb-model in wt-b.
    assert.equal(valAfter(argsOf(reviewers[0]), '--model'), 'wb-model', 'subtask 1 reviewer carries the OTHER seat (worker-b) model');
    assert.equal(valAfter(argsOf(reviewers[0]), '-C'), WT_B, 'subtask 1 reviewer reviews from wt-b');
    assert.equal(valAfter(argsOf(reviewers[0]), '-s'), 'read-only', 'subtask 1 reviewer cannot write');
    // t2 reviewer: OTHER seat is a -> wa-model in wt-a.
    assert.equal(valAfter(argsOf(reviewers[1]), '--model'), 'wa-model', 'subtask 2 reviewer carries the OTHER seat (worker-a) model');
    assert.equal(valAfter(argsOf(reviewers[1]), '-C'), WT_A, 'subtask 2 reviewer reviews from wt-a');
    assert.equal(valAfter(argsOf(reviewers[1]), '-s'), 'read-only', 'subtask 2 reviewer cannot write');
  });

  it('RED (G7): the reviewer prompt instructs the git RANGE review (git diff main..baton/wt-<seat>/subtask-<id>)', async () => {
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    await run(['pipeline', 'run'], io);
    const rev = reviewersOf(io.__runner)[0];
    assert.ok(rev, 'a reviewer child ran');
    const prompt = argsOf(rev).join(' ');
    // Refs are shared across worktrees, so the reviewer must be told to inspect
    // the exact range with git (not left to guess "the diff").
    assert.match(prompt, /git diff main\.\.baton\/wt-a\/subtask-t1/, 'the reviewer prompt names the exact `git diff main..<branch>` range to review');
  });
});

// ===========================================================================
describe('pipeline — verdict flow', () => {
  it('reviewer APPROVED -> the MERGER child runs (merger model); on its APPROVED the SUPERVISOR merges via mergeSubtask', async () => {
    const io = makePipeRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [...cleanSubtask(), ...cleanSubtask()]);
    io.__runner = io.superviseChild;
    await run(['pipeline', 'run'], io);

    // The merger child ran on the merger chain model and is NON-git-capable
    // (read-only) — it can re-check but never merge itself (finding 4).
    const mergers = childWithModel(io.__runner, 'mg-model');
    assert.ok(mergers.length >= 1, 'the merger role child runs after APPROVED');
    assert.equal(valAfter(argsOf(mergers[0]), '-s'), 'read-only', 'the merger child is read-only — it cannot write/merge itself');

    // The REAL merge happened through mergeSubtask (the supervisor). EVERY merge
    // and ff-only call carries the supervisor shape: merge at /repo, ff-only in a
    // seat cwd, all under the acquired merge lock.
    const m1 = io.__git.matching(/^merge baton\/wt-a\/subtask-t1$/);
    assert.equal(m1.length, 1, 'the subtask-1 branch is merged exactly once');
    for (const c of io.__git.matching(/^merge baton\//)) {
      assert.equal(c.cwd, '/repo', 'every subtask merge runs at the repo root');
      assert.equal(c.lockPresent, true, 'every subtask merge runs under the merge lock');
    }
    const ff = io.__git.matching(/^merge --ff-only main$/);
    assert.ok(ff.length >= 2, 'both worktrees fast-forward to main after each merge');
    for (const c of ff) {
      assert.ok(c.cwd === WT_A || c.cwd === WT_B, 'every ff-only sync runs in a seat worktree cwd');
      assert.equal(c.lockPresent, true, 'every ff-only sync runs under the merge lock');
    }
  });

  it('reviewer BLOCKED -> the SAME writer seat re-runs with the findings in its prompt', async () => {
    const io = makePipeRepo({ runner: undefined });
    // subtask 1: writer APPROVED, reviewer BLOCKED (findings), then writer re-run APPROVED, reviewer APPROVED, merger APPROVED; then subtask 2 clean.
    io.superviseChild = fakeRunner(io, [
      { verdict: 'APPROVED' }, // writer 1
      { verdict: 'BLOCKED', findings: 'REVIEW-FINDING-X' }, // reviewer 1
      { verdict: 'APPROVED' }, // writer 1 re-run
      { verdict: 'APPROVED' }, // reviewer 1 again
      { verdict: 'APPROVED' }, // merger 1
      ...cleanSubtask(), // subtask 2
    ]);
    io.__runner = io.superviseChild;
    await run(['pipeline', 'run'], io);
    // The re-run writer (2nd wa-model writer in wt-a) carries the findings.
    const writers = childWithModel(io.__runner, 'wa-model').filter((c) => valAfter(argsOf(c), '-s') === 'workspace-write');
    assert.ok(writers.length >= 2, 'the writer seat re-ran after the BLOCKED review');
    assert.match(argsOf(writers[1]).join(' '), /REVIEW-FINDING-X/, "the re-run writer's prompt carries the review findings");
  });

  it('review-gate cap exhaustion -> escalated, ESCALATION.md, exit 3, no 6th spawn', async () => {
    const io = makePipeRepo({ runner: undefined });
    // Reviewer BLOCKS five times; the 6th writer/reviewer pair must never spawn.
    io.superviseChild = fakeRunner(io, [
      { verdict: 'APPROVED' }, { verdict: 'BLOCKED', findings: 'f1' },
      { verdict: 'APPROVED' }, { verdict: 'BLOCKED', findings: 'f2' },
      { verdict: 'APPROVED' }, { verdict: 'BLOCKED', findings: 'f3' },
      { verdict: 'APPROVED' }, { verdict: 'BLOCKED', findings: 'f4' },
      { verdict: 'APPROVED' }, { verdict: 'BLOCKED', findings: 'f5' },
      { verdict: 'APPROVED' }, { verdict: 'BLOCKED', findings: 'f6' }, // must NEVER be consumed
    ]);
    io.__runner = io.superviseChild;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 3, 'a per-subtask review gate at the cap escalates');
    assert.ok(loopFile(io, 'ESCALATION.md'), 'an ESCALATION.md is written');
    // Exactly five writer+reviewer cycles ran — the 6th pair (and the f6 result)
    // are never consumed, and the merger never runs (finding 3).
    assert.equal(io.__runner.calls.length, 10, 'exactly 5 writers + 5 reviewers before escalation — no 6th spawn');
    assert.equal(writersOf(io.__runner).length, 5, 'five writer attempts');
    assert.equal(reviewersOf(io.__runner).length, 5, 'five review attempts');
    assert.equal(childWithModel(io.__runner, 'mg-model').length, 0, 'the merger never runs for an escalated subtask');
    const { state } = await loadLoopState('/repo', io);
    assert.equal(state.status, LOOP_STATUS.ESCALATED, 'the escalation is persisted to loop state');
  });

  it('merger BLOCKED -> the writer retries (same gate-cap discipline)', async () => {
    const io = makePipeRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [
      { verdict: 'APPROVED' }, // writer 1
      { verdict: 'APPROVED' }, // reviewer 1
      { verdict: 'BLOCKED', findings: 'MERGER-FINDING-Y' }, // merger 1 rejects
      { verdict: 'APPROVED' }, // writer re-run
      { verdict: 'APPROVED' }, // reviewer
      { verdict: 'APPROVED' }, // merger approves
      ...cleanSubtask(),
    ]);
    io.__runner = io.superviseChild;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 0, 'the subtask recovers after a merger rejection + writer retry');
    assert.ok(childWithModel(io.__runner, 'wa-model').filter((c) => valAfter(argsOf(c), '-s') === 'workspace-write').length >= 2, 'the writer retried after the merger BLOCKED');
  });
});

// ===========================================================================
describe('pipeline — merge failures park', () => {
  it('a merge CONFLICT from mergeSubtask parks the run (exit 4)', async () => {
    const git = pipelineGit({ over: { 'merge baton/wt-a/subtask-t1': { reject: true, code: 1, stdout: 'CONFLICT (content): Merge conflict in x' }, 'merge --abort': { stdout: '' } } });
    const io = makePipeRepo({ git, runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 4, 'a merge conflict parks the pipeline');
    assert.ok(io.__git.issued(/merge --abort/), 'the conflicted merge is aborted');
    const { state } = await loadLoopState('/repo', io);
    assert.equal(state.status, LOOP_STATUS.PARKED);
  });

  it('an attribution violation (foreign committer) blocks the merge and parks — no merge git call lands', async () => {
    const bad = logStdout(REC('badc0de', NAME, EMAIL, 'Rebase Bot', 'bot@ci.example', 'foreign committer'));
    const git = pipelineGit({ log: bad });
    const io = makePipeRepo({ git, runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 4, 'a failed attribution scan parks the pipeline');
    assert.equal(io.__git.matching(/^merge baton\//).length, 0, 'no subtask merge (any seat) is issued when the attribution scan fails');
    const { state } = await loadLoopState('/repo', io);
    assert.equal(state.status, LOOP_STATUS.PARKED);
  });
});

// ===========================================================================
describe('pipeline — worktree guard composition (preflight/postflight)', () => {
  it('(a) a DIRTY writer seat -> preflight refusal BEFORE any spawn: zero children, parked, exit 4', async () => {
    const git = pipelineGit({ over: { 'status --porcelain': { stdout: ' M src/x.js\n' } } });
    const io = makePipeRepo({ git, runner: undefined });
    io.superviseChild = fakeRunner(io, [...cleanSubtask(), ...cleanSubtask()]);
    io.__runner = io.superviseChild;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 4, 'a dirty seat parks the pipeline');
    assert.equal(io.__runner.calls.length, 0, 'preflight refuses BEFORE any child spawns');
    assert.ok(!io.__git.issued(/^merge baton\//), 'no merge on a preflight refusal');
    const { state } = await loadLoopState('/repo', io);
    assert.equal(state.status, LOOP_STATUS.PARKED, 'the parked state is persisted');
  });

  it('(b) a WRONG-branch writer seat -> preflight refusal BEFORE any spawn: zero children, parked, exit 4', async () => {
    const git = pipelineGit({ over: { 'rev-parse --abbrev-ref HEAD': { stdout: 'some-other-branch\n' } } });
    const io = makePipeRepo({ git, runner: undefined });
    io.superviseChild = fakeRunner(io, [...cleanSubtask(), ...cleanSubtask()]);
    io.__runner = io.superviseChild;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 4, 'a wrong-branch seat parks the pipeline');
    assert.equal(io.__runner.calls.length, 0, 'preflight refuses BEFORE any child spawns');
    assert.ok(!io.__git.issued(/^merge baton\//), 'no merge on a preflight refusal');
    const { state } = await loadLoopState('/repo', io);
    assert.equal(state.status, LOOP_STATUS.PARKED);
  });

  it('(c) POSTFLIGHT drift (the writer child moves main) -> parked, exit 4, no reviewer/merger, no merge', async () => {
    const git = pipelineGit();
    const io = makePipeRepo({ git, runner: undefined });
    // The writer child (first spawn) moves main between preflight-capture and postflight.
    io.superviseChild = fakeRunner(io, [
      { verdict: 'APPROVED', effect: () => git.moveMain('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') },
      ...cleanSubtask(),
    ]);
    io.__runner = io.superviseChild;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 4, 'postflight drift parks the pipeline');
    // Exactly one child ran (the writer); postflight refuses before the reviewer.
    assert.equal(io.__runner.calls.length, 1, 'only the writer ran — no reviewer/merger after postflight refusal');
    assert.equal(reviewersOf(io.__runner).length, 0, 'no reviewer spawned');
    assert.equal(childWithModel(io.__runner, 'mg-model').length, 0, 'no merger spawned');
    assert.ok(!io.__git.issued(/^merge baton\//), 'no merge on a postflight refusal');
    const { state } = await loadLoopState('/repo', io);
    assert.equal(state.status, LOOP_STATUS.PARKED);
  });
});

// ===========================================================================
describe('pipeline — completion', () => {
  it('both subtasks merged -> state done, exit 0; loop state + journal persisted under .handoff/loop', async () => {
    const io = makePipeRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [...cleanSubtask(), ...cleanSubtask()]);
    io.__runner = io.superviseChild;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 0);
    assert.equal(io.__git.matching(/^merge baton\/wt-a\/subtask-t1$/).length, 1, 'subtask 1 merged');
    assert.equal(io.__git.matching(/^merge baton\/wt-b\/subtask-t2$/).length, 1, 'subtask 2 merged');
    const { state } = await loadLoopState('/repo', io);
    assert.equal(state.status, LOOP_STATUS.DONE, 'the pipeline completed');
    assert.ok(loopFile(io, 'state.json'), 'loop state persisted');
    assert.ok(io.fs.existsSync(loopPaths('/repo').journal), 'the loop journal persisted');
  });
});

// ===========================================================================
// G1 (A1/B1/B2) — a claude worker seat's writer child carries its model + cwd.
describe('pipeline — G1: a claude-code worker seat writer carries model + seat cwd', () => {
  // worker-b on claude-code so subtask 2's writer is a claude child.
  const CLAUDE_SEAT_CONFIG = { ...PIPELINE_CONFIG, roles: { ...PIPELINE_CONFIG.roles, 'worker-b': ['claude-code/cc-writer'] } };

  it('RED (G1): the claude writer for the wt-b subtask runs in wt-b (spec.cwd) with --model cc-writer', async () => {
    const io = makePipeRepo({ config: CLAUDE_SEAT_CONFIG, runner: undefined });
    io.superviseChild = fakeRunner(io, [...cleanSubtask(), ...cleanSubtask()]);
    io.__runner = io.superviseChild;
    await run(['pipeline', 'run'], io);
    // subtask 2 writer is the write-capable claude child (command 'claude').
    const claudeWriter = io.__runner.calls.find((c) => c.command === 'claude' && argsOf(c).includes('cc-writer'));
    assert.ok(claudeWriter, 'the wt-b writer ran as a claude child on the resolved model');
    assert.equal(claudeWriter.spec.cwd, WT_B, 'the claude writer runs in its seat worktree (spec.cwd), not the supervisor cwd');
    assert.equal(valAfter(argsOf(claudeWriter), '--output-format'), 'json', 'the claude writer emits a structured result');
  });
});

// ===========================================================================
// G2 (A2/B3) — pipeline preconditions, caps, resume, run-lock.
describe('pipeline — G2: cap validation / resume / run-lock / stale branch', () => {
  it('RED (G2): iterationCap 6 in loop.json is REJECTED (exit 2) BEFORE any spawn (the 5-cap is a hard invariant)', async () => {
    const io = makePipeRepo({ spec: pipelineSpec({ budgets: { iterationCap: 6, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 } }) });
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 2, 'a spec asking for a 6th iteration is invalid');
    assert.match(io.stderrText() + io.stdoutText(), /iterationCap|cap/i, 'the error names the cap');
    assert.equal(io.__runner.calls.length, 0, 'no child spawns for an invalid spec');
  });

  it('RED (G2): a LIVE supervisor.lock refuses pipeline run (exit 1), zero spawns', async () => {
    const io = makePipeRepo();
    io.processAlive = (p) => p === 55555;
    const p = loopPaths('/repo');
    io.fs.mkdirSync(p.dir, { recursive: true });
    io.fs.writeFileSync(`${p.dir}/supervisor.lock`, JSON.stringify({ host: 'pipe-host', pid: 55555, startTime: 222, runId: 'other' }));
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 1, 'a live supervisor blocks a concurrent pipeline run');
    assert.match(io.stderrText() + io.stdoutText(), /55555|lock|supervisor/i, 'the refusal names the live supervisor');
    assert.equal(io.__runner.calls.length, 0, 'no child spawned while another supervisor is live');
  });

  it('RED (G2): a stale pre-existing subtask branch PARKS (exit 4) instead of crashing', async () => {
    const git = pipelineGit({ existingBranches: ['baton/wt-a/subtask-t1'] });
    const io = makePipeRepo({ git, runner: undefined });
    io.superviseChild = fakeRunner(io, [...cleanSubtask(), ...cleanSubtask()]);
    io.__runner = io.superviseChild;
    let code;
    await assert.doesNotReject(async () => { code = await run(['pipeline', 'run'], io); }, 'a stale branch must not crash the supervisor');
    assert.equal(code, 4, 'a stale subtask branch parks the run');
    assert.equal((await loadLoopState('/repo', io)).state.status, LOOP_STATUS.PARKED);
  });

  it('RED (G2): a second pipeline run RESUMES loadLoopState — cap counters survive re-invocation (no refund)', async () => {
    // A strict runner that NEVER falls back to default-APPROVED: it throws once
    // the script is exhausted, so a re-initing (refunding) impl is caught rather
    // than masked. The checkout -b branch state is neutralized by giving each run
    // a fresh git (a resumed run legitimately reuses persisted worktree state).
    const strictRunner = (io, script) => {
      const queue = [...script];
      const calls = [];
      const fn = (spec, opts) => {
        if (queue.length === 0) throw new Error('strictRunner: queue exhausted (no default-APPROVED fallback)');
        calls.push({ spec, opts, command: spec?.command, args: spec?.args ?? [] });
        const r = queue.shift();
        return Promise.resolve({ timedOut: false, exitCode: 0, verdict: r.verdict, findings: r.findings ?? '', logPath: opts.logPath });
      };
      fn.calls = calls;
      return fn;
    };
    const freshGit = () => { const g = pipelineGit(); g.setLockProbe(() => io.fs.existsSync(MERGE_LOCK)); return g; };

    const spec = pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] });
    const io = makePipeRepo({ spec, runner: undefined });

    // Run 1 crashes at EXACTLY 3 persisted review iterations: writer+reviewer(BLOCKED)
    // x3, then the 4th writer spawn throws (a supervisor crash mid-run).
    io.execFile = freshGit();
    const runner1 = strictRunner(io, [
      { verdict: 'APPROVED' }, { verdict: 'BLOCKED', findings: 'x' },
      { verdict: 'APPROVED' }, { verdict: 'BLOCKED', findings: 'x' },
      { verdict: 'APPROVED' }, { verdict: 'BLOCKED', findings: 'x' },
    ]);
    io.superviseChild = runner1;
    io.__runner = runner1;
    let firstCode = 'ran';
    try { firstCode = await run(['pipeline', 'run'], io); } catch { firstCode = 'crashed'; }
    assert.equal((await loadLoopState('/repo', io)).state.iterations['subtask-t1-review'], 3, 'exactly 3 review iterations persisted before the crash');

    // Run 2 resumes: two more BLOCKED reviews reach the 5-cap; the 6th escalates.
    // The strict runner throws on a 5th call, so a REFUNDING (re-init) impl — which
    // would need more attempts before escalating — fails to reach exit 3.
    io.execFile = freshGit();
    const runner2 = strictRunner(io, [
      { verdict: 'APPROVED' }, { verdict: 'BLOCKED', findings: 'x' }, // iteration 4
      { verdict: 'APPROVED' }, { verdict: 'BLOCKED', findings: 'x' }, // iteration 5 -> next spawn is refused by the cap
    ]);
    io.superviseChild = runner2;
    io.__runner = runner2;
    let second = 'ran';
    try { second = await run(['pipeline', 'run'], io); } catch { second = 'crashed'; }
    assert.equal(second, 3, 'the cap counter survived re-invocation — cumulative attempts (3+2) escalate, not refund');
    assert.equal((await loadLoopState('/repo', io)).state.status, LOOP_STATUS.ESCALATED);
  });
});

// ===========================================================================
// G3 (A3/B4) — pipeline consumes writer results/classification.
describe('pipeline — G3: writer result handling', () => {
  it('RED (G3): a writer BLOCKED retries the WRITER without spawning a reviewer for the failed attempt', async () => {
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), runner: undefined });
    io.superviseChild = fakeRunner(io, [
      { verdict: 'BLOCKED', findings: 'writer-not-done' }, // writer 1 fails its own self-check
      { verdict: 'APPROVED' }, // writer retry
      { verdict: 'APPROVED' }, // reviewer
      { verdict: 'APPROVED' }, // merger
    ]);
    io.__runner = io.superviseChild;
    await run(['pipeline', 'run'], io);
    // Two write-capable writer attempts ran; no reviewer ran until the writer passed.
    assert.equal(writersOf(io.__runner).length, 2, 'the BLOCKED writer retried');
    // The FIRST reviewer spawn must come AFTER the second (passing) writer — never
    // a review of the first, failed writer attempt.
    const firstReviewerIdx = io.__runner.calls.findIndex((c) => valAfter(argsOf(c), '-s') === 'read-only');
    const writerIdxs = io.__runner.calls.map((c, i) => (valAfter(argsOf(c), '-s') === 'workspace-write' ? i : -1)).filter((i) => i >= 0);
    assert.ok(firstReviewerIdx > writerIdxs[1], 'no reviewer spawned for the failed writer attempt (review only follows a passing writer)');
  });

  it('RED (G3): a writer whose LOG carries the claude session-limit banner routes to failover (not a plain review)', async () => {
    const io = makePipeRepo({
      spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }),
      files: { '/repo/.handoff/bundle.json': JSON.stringify(ownedBundle('claude-code', 'open'), null, 2) + '\n' },
      config: { ...PIPELINE_CONFIG, roles: { ...PIPELINE_CONFIG.roles, 'worker-a': ['claude-code/cc-w', 'codex/cx-w@xhigh'] } },
      runner: undefined,
    });
    io.superviseChild = fakeRunner(io, [
      { verdict: 'BLOCKED', exitCode: 1, logContent: `implementing...\n${CC_LIMIT}\n` }, // writer hits a limit
      { verdict: 'APPROVED' }, // relaunched writer
      { verdict: 'APPROVED' }, // reviewer
      { verdict: 'APPROVED' }, // merger
    ]);
    io.__runner = io.superviseChild;
    await run(['pipeline', 'run'], io);
    // Failover was consulted: the relaunched writer ran on the OTHER platform
    // (codex/cx-w — the failover-resolved model), and the failed (limit) writer
    // NEVER handed off to a reviewer.
    const relaunch = io.__runner.calls.find((c) => c.command === 'codex' && argsOf(c).includes('cx-w'));
    assert.ok(relaunch, 'the limit death was classified and the writer relaunched on the failover model (codex/cx-w)');
    const firstReviewerIdx = io.__runner.calls.findIndex((c) => valAfter(argsOf(c), '-s') === 'read-only');
    const relaunchIdx = io.__runner.calls.indexOf(relaunch);
    assert.ok(firstReviewerIdx === -1 || firstReviewerIdx > relaunchIdx, 'the limit-failed writer never handed off to a reviewer before the relaunch');
  });

  it('RED (G3): a writer that commits NOTHING (empty branch) is refused/parked — an empty branch never merges', async () => {
    // The stateful git returns an EMPTY main..branch log (no commits ahead).
    const git = pipelineGit({ log: '' });
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), git, runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 4, 'an empty subtask branch parks rather than merging nothing');
    assert.equal(io.__git.matching(/^merge baton\//).length, 0, 'no empty branch is merged to main');
  });
});

// ===========================================================================
// G5 (A5/B5) — reviewer-seat preflight + self-heal wiring.
describe('pipeline — G5: reviewer-seat preflight + self-heal', () => {
  it('RED (G5): a DIRTY reviewer seat parks BEFORE the reviewer spawns', async () => {
    // subtask 1 reviewer runs from wt-b; a dirty wt-b must be caught by preflight.
    const git = pipelineGit({ dirtyCwds: [WT_B] });
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), git, runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 4, 'a dirty reviewer seat parks the run');
    assert.equal(reviewersOf(io.__runner).length, 0, 'the reviewer never spawned into a dirty seat');
  });

  it('RED (G5): a listed-but-raw-deleted seat self-heals (prune + re-add), not a crash', async () => {
    // git genuinely LISTS wt-a (explicit seed) but its dir is raw-deleted, so any
    // in-cwd git in wt-a fails until self-heal prunes + re-adds it.
    const git = pipelineGit();
    git.seedWorktree(WT_A, 'baton/wt-a/base', { raw: true });
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), git, runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    let threw = false;
    try {
      await run(['pipeline', 'run'], io);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'a raw-deleted seat must self-heal, not crash the supervisor');
    assert.ok(io.__git.issued(/worktree prune/), 'the stale worktree metadata was pruned during self-heal');
    assert.ok(io.__git.matching(/worktree add/).some((c) => c.argstr.includes(WT_A)), 'the raw-deleted seat was re-added');
  });
});

// A persisted loop-state fixture. `flavor`/`specDigest` are the state-binding
// stamp (H5 design): flavor ∈ {'loop','pipeline'}; specDigest = dedupeKey of the
// driving spec (subtasks for pipeline, phases for loop).
function seedPipelineState(io, over = {}) {
  const state = {
    schema: 'baton/loop-state@1',
    runId: 'loop-seeded',
    goal: 'Ship the pipeline',
    phaseCount: 2,
    phaseIndex: 0,
    iterations: {},
    status: 'running',
    parkReason: null,
    escalation: null,
    smokeApproval: null,
    createdAt: T0,
    journalSeq: 0,
    flavor: 'pipeline',
    ...over,
  };
  io.fs.mkdirSync(loopPaths('/repo').dir, { recursive: true });
  io.fs.writeFileSync(loopPaths('/repo').state, JSON.stringify(state, null, 2) + '\n');
  return state;
}

// ===========================================================================
// H1 (B1) — the WRITER prompt must carry the verdict-tail contract.
describe('pipeline — H1: writer prompt carries the verdict-tail contract', () => {
  it('RED (H1): the writer prompt contains "End with exactly" and "VERDICT:" (a writer with no verdict parses BLOCKED-unparseable)', async () => {
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    await run(['pipeline', 'run'], io);
    const writer = writersOf(io.__runner)[0];
    assert.ok(writer, 'a writer child ran');
    const prompt = argsOf(writer).join(' ');
    assert.match(prompt, /End with exactly/, 'the writer prompt states the required tail');
    assert.match(prompt, /VERDICT:/, 'the writer prompt names the VERDICT line it must emit');
  });
});

// ===========================================================================
// H2 (A1/B2) — bounded failover: avoidEntries/avoid carry; exhaustion PARKS.
describe('pipeline — H2: bounded failover (avoid carries; exhaustion parks)', () => {
  // A recording runner that emits a platform-appropriate death banner and THROWS
  // once a bound is exceeded, so an unbounded ping-pong terminates the test RED.
  function boundedDeathRunner(io, { bound, banner }) {
    const calls = [];
    const fn = (/** @type {any} */ spec, /** @type {any} */ opts) => {
      calls.push({ spec, command: spec?.command, args: (spec?.args ?? []).map(String) });
      if (calls.length > bound) throw new Error(`unbounded failover: exceeded ${bound} child spawns (ping-pong)`);
      const text = typeof banner === 'function' ? banner(spec) : banner;
      io.fs.mkdirSync(opts.logPath.slice(0, opts.logPath.lastIndexOf('/')), { recursive: true });
      io.fs.writeFileSync(opts.logPath, `working...\n${text}\n`);
      return Promise.resolve({ timedOut: false, exitCode: 1, verdict: 'BLOCKED', findings: '', logPath: opts.logPath });
    };
    fn.calls = calls;
    return fn;
  }
  const modelsOf = (runner) => runner.calls.filter((c) => valAfter(c.args, '-s') === 'workspace-write').map((c) => valAfter(c.args, '--model'));

  it('RED (H2a): always-model-unavailable on a two-entry codex chain never re-picks a rejected model; all rejected -> PARK (bounded)', async () => {
    const config = { ...PIPELINE_CONFIG, roles: { ...PIPELINE_CONFIG.roles, 'worker-a': ['codex/wa1@xhigh', 'codex/wa2@xhigh'] } };
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), config, runner: undefined });
    const runner = boundedDeathRunner(io, { bound: 3, banner: MODEL_UNAVAIL }); // correct impl parks at 2 writers
    io.superviseChild = runner;
    io.__runner = runner;
    let code = 'ran';
    try { code = await run(['pipeline', 'run'], io); } catch { code = 'unbounded'; }
    assert.equal(code, 4, 'both models rejected -> the subtask parks (bounded, no infinite ping-pong)');
    // BOTH entries are attempted, in order, exactly once — then it parks.
    assert.deepEqual(modelsOf(runner), ['wa1', 'wa2'], `each chain entry is tried once, in order; got ${JSON.stringify(modelsOf(runner))}`);
    assert.ok(runner.calls.length <= 3, `the runner stayed within the throwing bound (no ping-pong); calls=${runner.calls.length}`);
  });

  it('RED (H2b): always-usage-limit across a cross-platform chain parks within a bounded child budget (no infinite loop)', async () => {
    const config = { ...PIPELINE_CONFIG, roles: { ...PIPELINE_CONFIG.roles, 'worker-a': ['claude-code/wa-cc', 'codex/wa-cx@xhigh'] } };
    const io = makePipeRepo({
      spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }),
      config,
      files: { '/repo/.handoff/bundle.json': JSON.stringify(ownedBundle('claude-code', 'open'), null, 2) + '\n' },
      runner: undefined,
    });
    const runner = boundedDeathRunner(io, { bound: 4, banner: (spec) => (spec.command === 'claude' ? CC_LIMIT : CODEX_LIMIT) });
    io.superviseChild = runner;
    io.__runner = runner;
    let code = 'ran';
    try { code = await run(['pipeline', 'run'], io); } catch { code = 'unbounded'; }
    assert.equal(code, 4, 'a repeatedly-limit-dying subtask parks within the child budget, never loops forever');
  });
});

// ===========================================================================
// H5 (B4) — state flavor + spec binding across loop/pipeline.
describe('pipeline — H5: state flavor + spec-digest binding', () => {
  it('RED (H5a): a state.json created by `loop run` (flavor loop) is REFUSED by pipeline run (exit 2 naming the mismatch), zero spawns', async () => {
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    seedPipelineState(io, { flavor: 'loop', phaseCount: 1 });
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 2, 'a loop-flavored state cannot be resumed as a pipeline');
    assert.match(io.stderrText() + io.stdoutText(), /flavor|loop|mismatch/i, 'the refusal names the flavor mismatch');
    assert.equal(io.__runner.calls.length, 0, 'no child spawned on a flavor mismatch');
  });

  it('RED (H5b): a changed subtasks list (stale specDigest) on resume REFUSES (exit 2), rather than misaligning phaseIndex', async () => {
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'a' }, { id: 't2', title: 'b' }] }), runner: undefined });
    io.superviseChild = fakeRunner(io, [...cleanSubtask(), ...cleanSubtask()]);
    io.__runner = io.superviseChild;
    // A prior run over a DIFFERENT subtask list: its specDigest no longer matches
    // the current subtasks, so resuming its phaseIndex would misalign.
    const oldSubtasks = [{ id: 't1', title: 'a' }, { id: 'REMOVED', title: 'gone' }, { id: 't2', title: 'b' }];
    seedPipelineState(io, { flavor: 'pipeline', specDigest: dedupeKey(oldSubtasks), phaseIndex: 1 });
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 2, 'a resume against a changed subtask list refuses rather than resuming a misaligned position');
    assert.match(io.stderrText() + io.stdoutText(), /subtask|spec|changed|digest/i, 'the refusal names the spec change');
    assert.equal(io.__runner.calls.length, 0, 'no child spawned on a spec-digest mismatch');
  });
});

// ===========================================================================
// H7 (B7) — a crash between merge and PHASE_ADVANCE advances, not empty-park.
describe('pipeline — H7: an already-merged subtask advances on resume (no empty-branch park)', () => {
  it('RED (H7): a resumed subtask whose branch is already an ancestor of main ADVANCES (no writer, no empty-branch park)', async () => {
    const subtasks = [{ id: 't1', title: 'first' }, { id: 't2', title: 'second' }];
    // t1's branch is already merged: `merge-base --is-ancestor` exits 0 AND
    // `log main..t1` is empty; t2 is a normal, unmerged subtask.
    const git = pipelineGit({ mergedBranches: ['baton/wt-a/subtask-t1'] });
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks }), git, runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask()); // enough for t2 only
    io.__runner = io.superviseChild;
    // A crash left the run at phaseIndex 0 (t1 merged but not advanced).
    seedPipelineState(io, { flavor: 'pipeline', specDigest: dedupeKey(subtasks), phaseIndex: 0, phaseCount: 2 });

    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 0, `an already-merged subtask advances and the run completes; stderr: ${io.stderrText()}`);
    assert.doesNotMatch(io.stderrText() + io.stdoutText(), /EMPTY branch|nothing to review or merge/i, 'the already-merged subtask is NOT mistaken for an empty branch');
    // t1 (seat a) is skipped — the first writer is t2's, in wt-b.
    const writers = writersOf(io.__runner);
    assert.ok(writers.length >= 1, 'the unmerged subtask still runs a writer');
    assert.equal(valAfter(argsOf(writers[0]), '-C'), WT_B, 'the first writer is t2 (wt-b) — t1 was recognized as already merged and skipped');
  });
});

function loopFile(io, name) {
  return io.files()[`${loopPaths('/repo').dir}/${name}`];
}
