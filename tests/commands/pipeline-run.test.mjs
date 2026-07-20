import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { run } from '../../core/src/cli.mjs';
import { loadLoopState, loopPaths, LOOP_STATUS, LOOP_EVENT } from '../../core/src/loop/state.mjs';
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
// D2 (dogfood milestone C) — `pipeline run` must actually PASS the main repo
// .git root to write-capable writer children: a linked worktree's index/lock
// live under <mainRoot>/.git/worktrees/<seat>, outside the seat-cwd sandbox
// (live child 002 could not commit: "sandbox only has read access to
// .git/worktrees/wt-a/index.lock"). The unit pin proves buildChildArgv honors
// opts.gitDir; THIS pin proves the command wires it through (pipeline.mjs:237
// still passes only {root: seatPath}).
describe('pipeline — D2: the writer spawn passes the main .git as a sandbox writable root', () => {
  // Every value that follows a `-c` flag in a codex argv (config args).
  const configArgs = (args) => args.map((a, i) => (a === '-c' ? args[i + 1] : null)).filter((v) => typeof v === 'string');

  it('RED (D2): the write-capable writer child runs in its SEAT cwd yet gets the MAIN /repo/.git in sandbox_workspace_write.writable_roots', async () => {
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    await run(['pipeline', 'run'], io);

    const writer = writersOf(io.__runner)[0];
    assert.ok(writer, 'a write-capable writer child ran');
    const args = argsOf(writer);
    // The cwd stays the seat worktree (codex passes it via -C) — the sandbox is
    // still rooted at the seat, the .git dir is only an ADDITIONAL writable root.
    assert.equal(valAfter(args, '-C'), WT_A, 'the writer runs in its seat worktree, not the main root');
    const wr = configArgs(args).find((v) => /sandbox_workspace_write\.writable_roots/.test(String(v)));
    assert.ok(wr, 'the writer argv carries a -c sandbox_workspace_write.writable_roots grant');
    assert.match(String(wr), /\/repo\/\.git/, 'the extra writable root is the MAIN repo .git dir (where the linked-worktree index/lock live)');
  });
});

// ===========================================================================
// D1 (dogfood milestone C) — classification reads the transcript TAIL, not the
// whole log: a child's OWN work product (a README diff hunk that DOCUMENTS
// usage-limit failover) contains a verbatim signature mid-log. A healthy exit-0
// APPROVED writer must not be routed into failover because of a signature in the
// body it wrote. Death banners sit at the END of a log; a body hunk must not
// classify. Seam: the call site classifies a bounded tail (~4 KB) — pin the
// behavior, not the constant (the signature is placed FAR from the end).
describe('pipeline — D1: classification uses the transcript tail, not the body', () => {
  // A signature buried in the body, then >>4 KB of clean output, then a clean
  // APPROVED verdict tail — the real shape of a child that wrote about limits.
  const bodySignatureLog = (signature) =>
    `writing README.md…\n${signature}\n` +
    `diff --git a/README.md b/README.md\n` +
    '+ a clean line of the documented diff hunk\n'.repeat(600) + // ~24 KB of body
    `\ntokens used: 512\nDone — committed on the branch.\nVERDICT: APPROVED\nFINDINGS: none\n`;

  it('RED (D1): a writer whose LOG BODY carries a usage-limit signature but whose TAIL is a clean exit-0 APPROVED is treated OK (proceeds to review, NO failover)', async () => {
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), runner: undefined });
    io.superviseChild = fakeRunner(io, [
      // worker-a is codex/wa-model → a codex usage-limit signature in the body.
      { verdict: 'APPROVED', exitCode: 0, logContent: bodySignatureLog(CODEX_LIMIT) },
      // reviewer + merger fall through to the default APPROVED.
    ]);
    io.__runner = io.superviseChild;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 0, `the subtask completes — the body signature was NOT treated as a death; stderr: ${io.stderrText()}`);
    assert.equal(writersOf(io.__runner).length, 1, 'the writer ran exactly once — no failover relaunch on its own work product');
    assert.ok(reviewersOf(io.__runner).length >= 1, 'the run proceeded to review (the writer was classified OK)');
  });

  it('GUARD (D1): a death banner at the END of the log still classifies and routes to failover', async () => {
    // The real death shape: clean body, banner in the TAIL. Model-unavailable
    // (codex) re-resolves the next chain entry with no bundle needed.
    const config = { ...PIPELINE_CONFIG, roles: { ...PIPELINE_CONFIG.roles, 'worker-a': ['codex/wa1@xhigh', 'codex/wa2@xhigh'] } };
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), config, runner: undefined });
    io.superviseChild = fakeRunner(io, [
      { verdict: 'BLOCKED', exitCode: 1, logContent: `did some work…\nall clean\n${MODEL_UNAVAIL}\n` }, // banner at the tail
      { verdict: 'APPROVED' }, // relaunched writer (wa2)
      { verdict: 'APPROVED' }, // reviewer
      { verdict: 'APPROVED' }, // merger
    ]);
    io.__runner = io.superviseChild;
    await run(['pipeline', 'run'], io);
    const relaunch = io.__runner.calls.find((c) => c.command === 'codex' && argsOf(c).includes('wa2'));
    assert.ok(relaunch, 'a tail banner is still classified — the writer relaunched on the next chain entry (wa2)');
  });
});

// ===========================================================================
// D4 (dogfood milestone C) — a plain BLOCKED writer retry must not re-resolve
// from the ORIGINAL chain, ignoring entries already avoided by failover.
// subtaskAvoidEntries must feed EVERY writer resolution for the subtask, not
// only runFailover. Live: after sol→gpt-5.5 relaunch, a BLOCKED retry reset the
// writer to resolveOne('worker-a') = sol again (the avoided, dead entry).
describe('pipeline — D4: avoided entries carry into a plain BLOCKED writer retry', () => {
  const writerModels = (runner) => writersOf(runner).map((c) => valAfter(argsOf(c), '--model'));

  it('RED (D4): after a model-unavailable relaunch onto wa2, a later BLOCKED retry re-runs wa2 (NOT the avoided wa1) — exactly one wa1 attempt', async () => {
    const config = { ...PIPELINE_CONFIG, roles: { ...PIPELINE_CONFIG.roles, 'worker-a': ['codex/wa1@xhigh', 'codex/wa2@xhigh'] } };
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), config, runner: undefined });
    // wa1 ALWAYS dies model-unavailable; wa2 self-check-BLOCKs once, then APPROVES.
    // reviewer (sr-model) and merger (mg-model) approve.
    const wa2Queue = [{ verdict: 'BLOCKED', exitCode: 0 }, { verdict: 'APPROVED', exitCode: 0 }];
    const calls = [];
    const runner = (spec, opts) => {
      const args = (spec?.args ?? []).map(String);
      const model = args[args.indexOf('--model') + 1];
      calls.push({ spec, command: spec?.command, args, model });
      let r;
      if (model === 'wa1') {
        io.fs.mkdirSync(opts.logPath.slice(0, opts.logPath.lastIndexOf('/')), { recursive: true });
        io.fs.writeFileSync(opts.logPath, `working…\n${MODEL_UNAVAIL}\n`);
        r = { verdict: 'BLOCKED', exitCode: 1 };
      } else if (model === 'wa2') {
        r = wa2Queue.shift() ?? { verdict: 'APPROVED', exitCode: 0 };
      } else {
        r = { verdict: 'APPROVED', exitCode: 0 };
      }
      return Promise.resolve({ timedOut: false, exitCode: r.exitCode ?? 0, verdict: r.verdict, findings: '', logPath: opts.logPath });
    };
    runner.calls = calls;
    io.superviseChild = runner;
    io.__runner = runner;

    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 0, `the subtask completes on wa2 after the BLOCKED retry; stderr: ${io.stderrText()}`);
    const models = writerModels(runner);
    assert.equal(models.filter((m) => m === 'wa1').length, 1, `wa1 (avoided/dead) is attempted exactly once — the BLOCKED retry must re-pick wa2, not the original chain head; got ${JSON.stringify(models)}`);
    assert.ok(models.filter((m) => m === 'wa2').length >= 2, 'wa2 ran the BLOCKED attempt AND the passing retry');
  });
});

// ===========================================================================
// D5 (dogfood milestone C) — the sessionHint passed to failover/checkpoint is
// the runId itself, with NO double 'loop-' prefix. Live artifact:
// 'loop-loop-6a96bf7b9ce6' (runId is already 'loop-<hex>').
describe('pipeline — D5: failover sessionHint is the runId (no double loop- prefix)', () => {
  it('RED (D5): after a usage-limit failover the received bundle is owned by the runId, not loop-<runId>', async () => {
    const io = makePipeRepo({
      spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }),
      files: { '/repo/.handoff/bundle.json': JSON.stringify(ownedBundle('claude-code', 'open'), null, 2) + '\n' },
      config: { ...PIPELINE_CONFIG, roles: { ...PIPELINE_CONFIG.roles, 'worker-a': ['claude-code/cc-w', 'codex/cx-w@xhigh'] } },
      runner: undefined,
    });
    io.superviseChild = fakeRunner(io, [
      { verdict: 'BLOCKED', exitCode: 1, logContent: `implementing…\n${CC_LIMIT}\n` }, // writer usage-limit → seal/receive
      { verdict: 'APPROVED' }, // relaunched writer (cx-w)
      { verdict: 'APPROVED' }, // reviewer
      { verdict: 'APPROVED' }, // merger
    ]);
    io.__runner = io.superviseChild;
    await run(['pipeline', 'run'], io);
    const runId = (await loadLoopState('/repo', io)).state.runId;
    assert.match(runId, /^loop-/, 'sanity: the runId is already loop-prefixed');
    const bundle = JSON.parse(io.files()['/repo/.handoff/bundle.json']);
    assert.equal(bundle.origin.sessionHint, runId, 'the failover/checkpoint session hint is the runId itself');
    assert.doesNotMatch(String(bundle.origin.sessionHint), /^loop-loop-/, 'no double loop- prefix (the live loop-loop-<hex> bug)');
  });
});

// ===========================================================================
// D6 (dogfood milestone C, attempt 2) — reviewer and merger children get the
// SAME classify→failover treatment as writers. Live: the subtask-reviewer
// inherits the other seat's worker chain whose head was a dead model; each
// unparseable death counted as a BLOCKED review and burned the whole gate cap.
// A failure-class death must re-resolve the role (model-unavailable → entry
// avoid), NOT consume a gate iteration, and park on chain exhaustion.
describe('pipeline — D6: reviewer & merger get classify→failover like writers', () => {
  const MU_LOG = `working…\n${MODEL_UNAVAIL}\n`;
  const approve = () => ({ verdict: 'APPROVED', exitCode: 0 });
  const deathMU = () => ({ verdict: 'BLOCKED', exitCode: 1, logContent: MU_LOG });
  // A child runner keyed on the spawn's --model. handlers[model] is a function
  // called per spawn (closures model queues); the default is APPROVED. Throws
  // past `bound` so an unbounded re-resolution loop terminates the test RED.
  function byModelRunner(io, handlers, { bound = 40 } = {}) {
    const calls = [];
    const fn = (spec, opts) => {
      const args = (spec?.args ?? []).map(String);
      const model = args[args.indexOf('--model') + 1];
      calls.push({ spec, command: spec?.command, args, model });
      if (calls.length > bound) throw new Error(`unbounded failover: exceeded ${bound} spawns`);
      const h = handlers[model] ?? approve;
      const r = h();
      if (typeof r.logContent === 'string' && opts.logPath) {
        io.fs.mkdirSync(opts.logPath.slice(0, opts.logPath.lastIndexOf('/')), { recursive: true });
        io.fs.writeFileSync(opts.logPath, r.logContent);
      }
      return Promise.resolve({ timedOut: false, exitCode: r.exitCode ?? 0, verdict: r.verdict ?? 'APPROVED', findings: r.findings ?? '', logPath: opts.logPath });
    };
    fn.calls = calls;
    return fn;
  }
  const reviewerModels = (runner) => reviewersOf(runner).map((c) => valAfter(argsOf(c), '--model'));
  const mergersOf = (runner) => runner.calls.filter((c) => argsOf(c).join(' ').includes('You are the merger'));
  const mergerModels = (runner) => mergersOf(runner).map((c) => valAfter(argsOf(c), '--model'));
  const MERGES = `${loopPaths('/repo').dir}/merges.ndjson`;
  const mergeReceipts = (io) => {
    const raw = io.files()[MERGES];
    return typeof raw === 'string' ? raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)) : [];
  };
  // Transitions are journaled — a re-resolved death must leave NO gate-iteration
  // event, not merely a snapshot counter that happens to read 0.
  const gateIterationEvents = (io, gate) => {
    const raw = io.files()[loopPaths('/repo').journal];
    const events = typeof raw === 'string' ? raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)) : [];
    return events.filter((e) => e.type === 'gate-iteration' && e.gate === gate);
  };

  it('RED (D6a): a model-unavailable subtask-reviewer re-resolves the next chain entry (one r1 then r2), no gate burn, run DONE', async () => {
    // subtask t1 uses seat a; the reviewer draws the OTHER seat's chain (worker-b).
    const config = { ...PIPELINE_CONFIG, roles: { ...PIPELINE_CONFIG.roles, 'worker-a': ['codex/wa-model@xhigh'], 'worker-b': ['codex/r1@xhigh', 'codex/r2@xhigh'] } };
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), config, runner: undefined });
    const runner = byModelRunner(io, { 'wa-model': approve, r1: deathMU, r2: approve, 'mg-model': approve });
    io.superviseChild = runner;
    io.__runner = runner;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 0, `the review succeeds via re-resolution; stderr: ${io.stderrText()}`);
    assert.deepEqual(reviewerModels(runner), ['r1', 'r2'], `the dead reviewer entry re-resolved to the next; got ${JSON.stringify(reviewerModels(runner))}`);
    const state = (await loadLoopState('/repo', io)).state;
    assert.equal(state.iterations['subtask-t1-review'] ?? 0, 0, 'a model-unavailable reviewer death did NOT burn a gate iteration');
    assert.equal(gateIterationEvents(io, 'subtask-t1-review').length, 0, 'NO gate-iteration event was journaled for the reviewer death');
    assert.equal(state.status, LOOP_STATUS.DONE, 'the run completed');
  });

  it('RED (D6b): a model-unavailable merger re-resolves the next chain entry (one m1 then m2), the merge lands, run DONE', async () => {
    const config = { ...PIPELINE_CONFIG, roles: { ...PIPELINE_CONFIG.roles, merger: ['codex/m1@xhigh', 'codex/m2@xhigh'] } };
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), config, runner: undefined });
    const runner = byModelRunner(io, { 'wa-model': approve, 'wb-model': approve, m1: deathMU, m2: approve });
    io.superviseChild = runner;
    io.__runner = runner;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 0, `the merge-check succeeds via re-resolution; stderr: ${io.stderrText()}`);
    assert.deepEqual(mergerModels(runner), ['m1', 'm2'], `the dead merger entry re-resolved to the next; got ${JSON.stringify(mergerModels(runner))}`);
    assert.ok(mergeReceipts(io).some((r) => r.subtaskId === 't1'), 'the subtask actually merged (a receipt was written)');
    const state = (await loadLoopState('/repo', io)).state;
    assert.equal(state.iterations['subtask-t1-review'] ?? 0, 0, 'a model-unavailable merger death did NOT burn a gate iteration');
    assert.equal(gateIterationEvents(io, 'subtask-t1-review').length, 0, 'NO gate-iteration event was journaled for the merger death');
    assert.equal(state.status, LOOP_STATUS.DONE, 'the run completed');
  });

  it('GUARD (D6c): a genuine BLOCKED reviewer verdict STILL consumes a gate iteration (retry-with-findings unchanged)', async () => {
    // A clean exit-0 reviewer that BLOCKS on merits (no death signature), then approves.
    const reviewQ = [{ verdict: 'BLOCKED', exitCode: 0, findings: 'real review finding' }, { verdict: 'APPROVED', exitCode: 0 }];
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), runner: undefined });
    const runner = byModelRunner(io, { 'wa-model': approve, 'wb-model': () => reviewQ.shift() ?? approve(), 'mg-model': approve });
    io.superviseChild = runner;
    io.__runner = runner;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 0, `the subtask completes after the writer addresses the review; stderr: ${io.stderrText()}`);
    assert.equal((await loadLoopState('/repo', io)).state.iterations['subtask-t1-review'], 1, 'a genuine BLOCKED review consumes exactly one gate iteration');
  });

  it('RED (D6d): a reviewer chain that is FULLY model-unavailable PARKS (bounded), not a cap-burn escalation', async () => {
    const config = { ...PIPELINE_CONFIG, roles: { ...PIPELINE_CONFIG.roles, 'worker-a': ['codex/wa-model@xhigh'], 'worker-b': ['codex/r1@xhigh', 'codex/r2@xhigh'] } };
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }], budgets: { iterationCap: 3, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 } }), config, runner: undefined });
    const runner = byModelRunner(io, { 'wa-model': approve, r1: deathMU, r2: deathMU, 'mg-model': approve }, { bound: 16 });
    io.superviseChild = runner;
    io.__runner = runner;
    let code = 'ran';
    try { code = await run(['pipeline', 'run'], io); } catch { code = 'unbounded'; }
    assert.equal(code, 4, 'reviewer chain exhaustion PARKS (exit 4), never a cap-burn escalation');
    assert.ok(reviewerModels(runner).length <= 4, `reviewer re-resolution is bounded (one pass over the chain), not per-iteration re-run; got ${JSON.stringify(reviewerModels(runner))}`);
  });
});

// ===========================================================================
// D7 (dogfood milestone C, attempt 2) — the pipeline's escalation must PERSIST.
// Live: the synthesized state spec drops budgets, so the reducer caps at its
// default (5) while drivePipeline enforces the spec cap — the run exited 3 with
// state.json still status 'running', escalation null.
describe('pipeline — D7: escalation persists to state.json', () => {
  it('RED (D7): hitting the enforced cap exits 3 AND persists status escalated naming the gate', async () => {
    const subtasks = [{ id: 't1', title: 'only' }];
    const gate = 'subtask-t1-review';
    const io = makePipeRepo({
      spec: pipelineSpec({ subtasks, budgets: { iterationCap: 2, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 } }),
      runner: undefined,
    });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    // Seed the gate AT the enforced cap (2) — the top-of-loop cap check fires
    // before any child spawns.
    seedPipelineState(io, { flavor: 'pipeline', specDigest: dedupeKey(subtasks), phaseIndex: 0, phaseCount: 1, status: 'running', iterations: { [gate]: 2 } });
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 3, 'a capped gate escalates (exit 3)');
    // The RAW snapshot must itself be escalated — loadLoopState replays the
    // journal over the snapshot, which could MASK a state.json left 'running'.
    const rawState = JSON.parse(io.files()[loopPaths('/repo').state]);
    assert.equal(rawState.status, 'escalated', 'the RAW state.json snapshot is escalated (not merely masked by journal replay)');
    assert.ok(rawState.escalation && rawState.escalation.gate === gate, `the raw snapshot escalation names the gate; got ${JSON.stringify(rawState.escalation)}`);
    // And the loaded view agrees.
    const { state } = await loadLoopState('/repo', io);
    assert.equal(state.status, LOOP_STATUS.ESCALATED, 'the loaded state is escalated — a resume must not see a running run');
    assert.ok(state.escalation && state.escalation.gate === gate, `the loaded escalation names the gate; got ${JSON.stringify(state.escalation)}`);
  });
});

// ===========================================================================
// D8 (dogfood milestone C, attempt 2) — an escalation with EMPTY findings still
// records WHY: a bounded tail of the last child's log lands in ESCALATION.md so
// the operator is not handed a blank escalation. The findings-present path stays
// byte-compatible.
describe('pipeline — D8: ESCALATION.md carries the last-child log tail when findings are empty', () => {
  const ESC = `${loopPaths('/repo').dir}/ESCALATION.md`;

  it('RED (D8): an empty-findings escalation includes the dead child’s distinctive log tail', async () => {
    const marker = 'DISTINCTIVE_D8_TAIL_MARKER_Q9Z';
    const io = makePipeRepo({
      spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }], budgets: { iterationCap: 1, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 } }),
      runner: undefined,
    });
    io.superviseChild = fakeRunner(io, [
      { verdict: 'APPROVED', exitCode: 0 }, // writer passes
      { verdict: 'BLOCKED', exitCode: 0, findings: '', logContent: `review scratch…\n${marker}\n` }, // reviewer BLOCKS with EMPTY findings but a telling log
    ]);
    io.__runner = io.superviseChild;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 3, 'the gate escalates at the cap');
    const esc = io.files()[ESC];
    assert.ok(esc, 'ESCALATION.md was written');
    assert.match(esc, new RegExp(marker), 'an empty-findings escalation includes the last child’s log tail so the operator sees WHY');
  });

  it('GUARD (D8): when findings are present they appear in ESCALATION.md as today (findings path unchanged)', async () => {
    const finding = 'CONCRETE_FINDING_TEXT_D8';
    const io = makePipeRepo({
      spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }], budgets: { iterationCap: 1, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 } }),
      runner: undefined,
    });
    io.superviseChild = fakeRunner(io, [
      { verdict: 'APPROVED', exitCode: 0 }, // writer
      { verdict: 'BLOCKED', exitCode: 0, findings: finding }, // reviewer BLOCKS with concrete findings
    ]);
    io.__runner = io.superviseChild;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 3, 'the gate escalates at the cap');
    const esc = io.files()[ESC];
    // Byte-for-byte the current findings-present format (pipeline.mjs:408) — a
    // format change OR an appended log tail on THIS path fails the guard.
    const expected = `# Pipeline escalation\n\nGate 'subtask-t1-review' exhausted its 1-iteration cap.\nLast findings:\n\n${finding}\n`;
    assert.equal(esc, expected, 'the findings-present ESCALATION.md is byte-identical to today (no appended tail when findings exist)');
  });
});

// ===========================================================================
// ITEM 2 (v1.1) — trunk derivation. Replace hardcoded 'main' with the repo's
// actual default branch (git symbolic-ref refs/remotes/origin/HEAD → fallback
// rev-parse --abbrev-ref HEAD at setup), recorded in state and reused, never
// re-derived mid-run. Pinned in a MASTER-trunk fake repo — the observable is
// "master used everywhere; one derivation", not the exact command.

// A fake git modeling a MASTER-trunk repo: the default branch is 'master'
// (symbolic-ref refs/remotes/origin/HEAD → origin/master; fallback rev-parse
// --abbrev-ref HEAD at the ROOT → master). It answers 'main' refs LENIENTLY
// (same sha/ranges) so a main-hardcoded impl still runs end to end — the pin's
// teeth are that NO 'main' appears in the recorded git argv. deriveThrows makes
// the default-branch derivation fail (to prove a resume reuses a stamped trunk).
// Structured argv classifiers shared by the fake's dispatch AND its call-count
// helpers, so both agree on what "a trunk-derivation probe" is (verifier iter 3):
// any arg order, plus symbolic-ref HEAD and branch --show-current variants.
function isDerivationShape(args) {
  const has = (a) => args.includes(a);
  return (
    (has('symbolic-ref') && (has('refs/remotes/origin/HEAD') || has('HEAD'))) || // (a) + (d)
    (has('rev-parse') && has('--abbrev-ref') && has('HEAD')) || // (b) any order
    (has('branch') && has('--show-current')) // (c)
  );
}
// The one legit exception: rev-parse --abbrev-ref HEAD (any order) in a seat cwd.
function isSeatHeadProbe(args, cwd) {
  const seat = cwd === WT_A || cwd === WT_B;
  return seat && args.includes('rev-parse') && args.includes('--abbrev-ref') && args.includes('HEAD');
}

function masterGit({ merged = [], existingBranches = [], dirtyCwds = [], log = CLEAN_LOG, deriveThrows = false } = {}) {
  const added = /** @type {Map<string,string>} */ (new Map());
  const branchAt = /** @type {Map<string,string>} */ (new Map());
  const branches = new Set(existingBranches);
  const dirty = new Set(dirtyCwds);
  const mergedSet = new Set(merged);
  const calls = /** @type {any[]} */ ([]);
  const lockProbeRef = { fn: /** @type {null | (() => boolean)} */ (null) };
  const list = () => {
    const entries = [{ path: '/repo', branch: 'master' }];
    for (const [path, branch] of added) entries.push({ path, branch: branchAt.get(path) ?? branch });
    return entries.map((e) => `worktree ${e.path}\nHEAD ${MAIN_SHA}\nbranch refs/heads/${e.branch}\n`).join('\n');
  };
  const fn = (/** @type {string} */ cmd, /** @type {string[]} */ args = [], /** @type {any} */ opts = {}) => {
    const argstr = args.join(' ');
    calls.push({ cmd, args, argstr, cwd: opts?.cwd, lockPresent: lockProbeRef.fn ? lockProbeRef.fn() : undefined });
    if (cmd !== 'git') return Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    // ---- structured trunk-derivation classification (verifier iter 3) --------
    // Every current-/default-branch probe shape is classified by ARGV, not by an
    // exact string, so arg-order variants and alternate commands can't slip past:
    //   (a) symbolic-ref naming refs/remotes/origin/HEAD
    //   (b) rev-parse containing BOTH --abbrev-ref and HEAD (any order)
    //   (c) branch --show-current
    //   (d) symbolic-ref HEAD
    // The ONLY legit exception is form (b) issued in a seat cwd (the pipeline's
    // alreadyOnBranch / preflight / postflight HEAD checks).
    const seatCwd = opts?.cwd === WT_A || opts?.cwd === WT_B;
    if (isSeatHeadProbe(args, opts?.cwd)) {
      const dflt = opts.cwd === WT_A ? 'baton/wt-a/base' : 'baton/wt-b/base'; // never 'master' — a seat probe is never the trunk
      return Promise.resolve({ stdout: `${branchAt.get(opts.cwd) ?? dflt}\n`, stderr: '' });
    }
    if (isDerivationShape(args) && !seatCwd) {
      // A derivation attempt (root fallback or a stray probe in any non-seat cwd).
      // deriveThrows makes EVERY such form fail so it can't silently succeed via a
      // generic catch-all; otherwise it returns the shape-appropriate default.
      if (deriveThrows) return Promise.reject(Object.assign(new Error('fatal: no default branch'), { code: 128, stderr: 'fatal: no default branch\n' }));
      if (args.includes('symbolic-ref')) return Promise.resolve({ stdout: `${args.includes('refs/remotes/origin/HEAD') ? 'refs/remotes/origin/master' : 'refs/heads/master'}\n`, stderr: '' });
      return Promise.resolve({ stdout: 'master\n', stderr: '' }); // rev-parse --abbrev-ref HEAD / branch --show-current
    }
    if (argstr.startsWith('worktree list')) return Promise.resolve({ stdout: list(), stderr: '' });
    if (argstr.startsWith('worktree add')) {
      const path = args.find((a) => a.startsWith('/repo/.worktrees/'));
      const bi = args.indexOf('-b');
      const branch = bi >= 0 ? args[bi + 1] : 'baton/wt-x/base';
      if (path) { added.set(path, branch); branchAt.set(path, branch); }
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    if (argstr.startsWith('worktree prune') || argstr.startsWith('worktree remove')) return Promise.resolve({ stdout: '', stderr: '' });
    if (argstr.startsWith('checkout -b')) {
      const target = args[args.indexOf('-b') + 1];
      if (branches.has(target)) return Promise.reject(Object.assign(new Error(`fatal: a branch named '${target}' already exists`), { code: 128, stderr: `fatal: a branch named '${target}' already exists\n` }));
      branches.add(target);
      if (opts?.cwd) branchAt.set(opts.cwd, target);
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    if (argstr.startsWith('status --porcelain')) return Promise.resolve({ stdout: dirty.has(opts?.cwd) ? ' M dirty.txt\n' : '', stderr: '' });
    // merge-base --is-ancestor <branch> <trunk>: exit 0 iff branch already merged.
    if (argstr.startsWith('merge-base --is-ancestor')) {
      const b = args[args.indexOf('--is-ancestor') + 1];
      return mergedSet.has(b) ? Promise.resolve({ stdout: '', stderr: '' }) : Promise.reject(Object.assign(new Error('not an ancestor'), { code: 1, stdout: '', stderr: '' }));
    }
    // Lenient: rev-parse of ANY single ref (master OR main) resolves to the sha.
    if (argstr.startsWith('rev-parse')) return Promise.resolve({ stdout: `${MAIN_SHA}\n`, stderr: '' });
    if (argstr.startsWith('log ')) {
      const range = args.find((a) => /\.\./.test(String(a))) ?? '';
      const branch = String(range).split('..')[1];
      if (branch && mergedSet.has(branch)) return Promise.resolve({ stdout: '', stderr: '' }); // merged → empty
      return Promise.resolve({ stdout: log, stderr: '' });
    }
    if (argstr.startsWith('merge')) return Promise.resolve({ stdout: 'Fast-forward', stderr: '' }); // merge <branch> and merge --ff-only <trunk>
    if (argstr.startsWith('branch -D')) return Promise.resolve({ stdout: '', stderr: '' });
    return Promise.reject(Object.assign(new Error(`unstubbed git: ${argstr}`), { code: 'ENOSTUB' }));
  };
  fn.calls = calls;
  fn.git = () => calls.filter((c) => c.cmd === 'git');
  fn.mainCalls = () => fn.git().filter((c) => c.argstr.includes('main'));
  // A trunk-derivation attempt = ANY derivation SHAPE (symbolic-ref origin/HEAD,
  // rev-parse --abbrev-ref HEAD in any order, branch --show-current, symbolic-ref
  // HEAD) that is NOT the legit seat HEAD probe. Counts seat-cwd re-derivations of
  // other shapes too — the only exclusion is the explicit seat HEAD-probe form —
  // so "derive once, never re-derive" is pinned by the count, arg-order-proof.
  fn.derivationCalls = () => fn.git().filter((c) => isDerivationShape(c.args) && !isSeatHeadProbe(c.args, c.cwd)).length;
  // The legit seat HEAD probes (alreadyOnBranch / preflight / postflight),
  // confined to the two seat cwds — asserted explicitly.
  fn.seatProbes = () => fn.git().filter((c) => isSeatHeadProbe(c.args, c.cwd));
  fn.setLockProbe = (/** @type {() => boolean} */ f) => { lockProbeRef.fn = f; };
  return fn;
}

describe('pipeline — trunk derivation (v1.1 item 2)', () => {
  const MERGES = `${loopPaths('/repo').dir}/merges.ndjson`;
  const mergeReceiptsOf = (io) => {
    const raw = io.files()[MERGES];
    return typeof raw === 'string' ? raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)) : [];
  };

  it('RED (trunk-1): a master-trunk pipeline completes DONE using master everywhere — no "main" in any git argv; prompts range over master', async () => {
    const git = masterGit();
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), git, runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 0, `a master-trunk run completes; stderr: ${io.stderrText()}`);
    assert.equal((await loadLoopState('/repo', io)).state.status, LOOP_STATUS.DONE, 'the run reached DONE');
    // Teeth: NO trunk touchpoint used the hardcoded 'main'.
    assert.deepEqual(git.mainCalls().map((c) => c.argstr), [], 'every trunk git call targets master — no main anywhere');
    // Reviewer prompt ranges over master..branch.
    const rev = reviewersOf(io.__runner)[0];
    assert.ok(rev, 'a reviewer ran');
    const revPrompt = argsOf(rev).join(' ');
    assert.match(revPrompt, /git diff master\.\.baton\/wt-a\/subtask-t1/, 'the reviewer prompt ranges over master..<branch>');
    assert.doesNotMatch(revPrompt, /\bmain\.\./, 'the reviewer prompt never ranges over main');
    // Merger prompt names master as the trunk.
    const merger = io.__runner.calls.find((c) => argsOf(c).join(' ').includes('You are the merger'));
    assert.ok(merger, 'a merger ran');
    assert.match(argsOf(merger).join(' '), /against master/, 'the merger prompt names master as the trunk');
    // Receipt shape unchanged.
    assert.ok(
      mergeReceiptsOf(io).some((r) => r.subtaskId === 't1' && r.branch === 'baton/wt-a/subtask-t1' && typeof r.mergedAt === 'string'),
      'the merge receipt keeps its {subtaskId, branch, mergedAt} shape',
    );
  });

  it('RED (trunk-2): the stale-branch park message names the trunk (git log master..<branch>), not main', async () => {
    const branch = 'baton/wt-a/subtask-t1';
    const git = masterGit({ merged: [branch] }); // is-ancestor true, empty master..branch, and NO receipt → stale park
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), git, runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 4, 'an ancestor-without-receipt stale branch parks');
    const out = io.stderrText() + io.stdoutText();
    assert.match(out, /git log master\.\.baton\/wt-a\/subtask-t1/, 'the stale-park message points at git log master..<branch>');
    assert.doesNotMatch(out, /\bmain\.\./, 'the stale-park message never ranges over main');
  });

  it('RED (trunk-3a): a fresh master-trunk run STAMPS the derived trunk into state.json', async () => {
    const git = masterGit();
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), git, runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    await run(['pipeline', 'run'], io);
    const state = JSON.parse(io.files()[loopPaths('/repo').state]);
    assert.equal(state.trunk, 'master', 'the derived trunk is persisted in state.json for reuse');
    assert.equal(git.derivationCalls(), 1, 'the trunk is derived EXACTLY once at init (one root-level derivation)');
  });

  it('RED (trunk-3b): resume REUSES the stamped trunk and does not re-derive (completes even when derivation now fails)', async () => {
    const subtasks = [{ id: 't1', title: 'only' }];
    const git = masterGit({ deriveThrows: true }); // deriving would fail now — the resume must not need it
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks }), git, runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    // A prior run already derived + stamped the trunk.
    seedPipelineState(io, { flavor: 'pipeline', specDigest: dedupeKey(subtasks), phaseIndex: 0, phaseCount: 1, status: 'running', trunk: 'master' });
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 0, `resume completes using the stamped trunk without re-deriving; stderr: ${io.stderrText()}`);
    assert.equal((await loadLoopState('/repo', io)).state.status, LOOP_STATUS.DONE, 'the resumed run reached DONE');
    assert.deepEqual(git.mainCalls().map((c) => c.argstr), [], 'the resumed run uses the stamped master everywhere');
    // Derive-once teeth: a stamped resume issues NO derivation — not symbolic-ref,
    // not a root fallback, and not a stray abbrev-ref in any non-seat cwd (a
    // seat-cwd re-derivation would count here too, since only WT_A/WT_B probes
    // are excluded).
    assert.equal(git.derivationCalls(), 0, 'a stamped resume NEVER re-derives the trunk (not even to catch-and-fallback, and not via a seat cwd)');
    // The exclusion is explicit: the only abbrev-ref HEAD calls are the known
    // legit seat probes, confined to the two seat cwds.
    assert.ok(git.seatProbes().length >= 1, 'the resume made its legit seat HEAD probes');
    assert.ok(git.seatProbes().every((c) => c.cwd === WT_A || c.cwd === WT_B), 'every abbrev-ref HEAD probe is a seat probe (WT_A/WT_B), never a disguised derivation');
  });

  it('RED (trunk-4): a stamped state WITHOUT a trunk field migrates — derives once and stamps it, never a refusal', async () => {
    const subtasks = [{ id: 't1', title: 'only' }];
    const git = masterGit();
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks }), git, runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    // A pre-trunk stamped state: flavor + specDigest present, but NO trunk field.
    // Missing trunk alone is NOT the I3 legacy-unstamped refusal.
    seedPipelineState(io, { flavor: 'pipeline', specDigest: dedupeKey(subtasks), phaseIndex: 0, phaseCount: 1, status: 'running' });
    const code = await run(['pipeline', 'run'], io);
    assert.notEqual(code, 2, 'a missing trunk field is additive migration, not a legacy-unstamped refusal');
    assert.equal(code, 0, `the run migrates and completes; stderr: ${io.stderrText()}`);
    const state = JSON.parse(io.files()[loopPaths('/repo').state]);
    assert.equal(state.trunk, 'master', 'the trunk is derived once and stamped on migration');
    assert.equal(git.derivationCalls(), 1, 'migration derives the trunk EXACTLY once, then stamps it');
  });

  it('RED (trunk-5): a receipt-backed already-merged subtask auto-advances under master (no t1 writer), zero main in argv', async () => {
    const subtasks = [{ id: 't1', title: 'first' }, { id: 't2', title: 'second' }];
    const t1Branch = 'baton/wt-a/subtask-t1';
    // t1 is genuinely merged under master: is-ancestor true, empty master..t1,
    // AND a receipt. t2 is unmerged and runs normally.
    const git = masterGit({ merged: [t1Branch] });
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks }), git, runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask()); // enough for t2 only
    io.__runner = io.superviseChild;
    seedPipelineState(io, { flavor: 'pipeline', specDigest: dedupeKey(subtasks), phaseIndex: 0, phaseCount: 2, status: 'running', trunk: 'master' });
    io.fs.mkdirSync(loopPaths('/repo').dir, { recursive: true });
    io.fs.writeFileSync(MERGES, JSON.stringify({ subtaskId: 't1', branch: t1Branch, mergedAt: T0 }) + '\n');

    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 0, `the receipt-backed t1 auto-advances and t2 completes; stderr: ${io.stderrText()}`);
    assert.doesNotMatch(io.stderrText() + io.stdoutText(), /EMPTY branch|nothing to review or merge|stale/i, 'a receipt-backed merged subtask is not mistaken for empty/stale under master');
    const writers = writersOf(io.__runner);
    assert.ok(writers.length >= 1, 'the unmerged subtask still runs a writer');
    assert.equal(valAfter(argsOf(writers[0]), '-C'), WT_B, 'the first writer is t2 (wt-b) — receipt-backed t1 was recognized as merged and skipped');
    assert.ok(!writers.some((c) => argsOf(c).join(' ').includes("subtask 't1'")), 'no writer ran for the already-merged t1');
    assert.deepEqual(git.mainCalls().map((c) => c.argstr), [], 'the already-merged recognizer and merge path use master — no main anywhere');
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
// I1 (A1/B1) — auto-advance requires a supervisor-owned MERGE RECEIPT, not just
// is-ancestor: a stale empty branch at main's tip is is-ancestor-true too, and
// must PARK, not silently skip the subtask.
//
// Merge-receipt shape (I1 design): append-only `.handoff/loop/merges.ndjson`,
// one line per merged subtask `{ subtaskId, branch, mergedAt }`. Auto-advance on
// resume requires is-ancestor(branch, main) AND a receipt for that subtask.
describe('pipeline — I1: merge-receipt-gated auto-advance', () => {
  const MERGES = `${loopPaths('/repo').dir}/merges.ndjson`;
  const seedReceipt = (io, subtaskId, branch) => {
    io.fs.mkdirSync(loopPaths('/repo').dir, { recursive: true });
    io.fs.writeFileSync(MERGES, JSON.stringify({ subtaskId, branch, mergedAt: T0 }) + '\n');
  };
  const receipts = (io) => {
    const raw = io.files()[MERGES];
    return typeof raw === 'string' ? raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)) : [];
  };

  it('RED (I1b): a receipt-backed already-merged subtask ADVANCES on resume (no writer, no empty-branch park)', async () => {
    const subtasks = [{ id: 't1', title: 'first' }, { id: 't2', title: 'second' }];
    // t1 is genuinely merged: is-ancestor true, empty main..t1, AND a receipt.
    const git = pipelineGit({ mergedBranches: ['baton/wt-a/subtask-t1'] });
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks }), git, runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask()); // enough for t2 only
    io.__runner = io.superviseChild;
    seedPipelineState(io, { flavor: 'pipeline', specDigest: dedupeKey(subtasks), phaseIndex: 0, phaseCount: 2 });
    seedReceipt(io, 't1', 'baton/wt-a/subtask-t1');

    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 0, `a receipt-backed merged subtask advances and the run completes; stderr: ${io.stderrText()}`);
    assert.doesNotMatch(io.stderrText() + io.stdoutText(), /EMPTY branch|nothing to review or merge|stale/i, 'a receipt-backed subtask is not mistaken for empty/stale');
    const writers = writersOf(io.__runner);
    assert.ok(writers.length >= 1, 'the unmerged subtask still runs a writer');
    assert.equal(valAfter(argsOf(writers[0]), '-C'), WT_B, 'the first writer is t2 (wt-b) — t1 was recognized as merged (receipt) and skipped');
  });

  it('RED (I1a): a stale EMPTY branch at main tip (is-ancestor true, NO receipt) PARKS as stale — never auto-advances', async () => {
    const subtasks = [{ id: 't1', title: 'first' }, { id: 't2', title: 'second' }];
    // t1's branch is empty at main's tip: is-ancestor true, empty main..t1 — but
    // NO merge receipt (the writer crashed before its first commit).
    const git = pipelineGit({ mergedBranches: ['baton/wt-a/subtask-t1'] });
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks }), git, runner: undefined });
    io.superviseChild = fakeRunner(io, [...cleanSubtask(), ...cleanSubtask()]);
    io.__runner = io.superviseChild;
    seedPipelineState(io, { flavor: 'pipeline', specDigest: dedupeKey(subtasks), phaseIndex: 0, phaseCount: 2 });
    // No receipt seeded.

    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 4, 'a receipt-less is-ancestor branch parks as stale rather than silently skipping the subtask');
    const out = io.stderrText() + io.stdoutText();
    assert.match(out, /stale/i, 'the park names the stale branch');
    assert.equal(io.__git.matching(/^merge baton\//).length, 0, 'nothing is merged for a stale empty branch');
    // J2: the message must hedge BOTH causes — each pinned SEPARATELY so a
    // single-cause misdiagnosis cannot pass — point at the range to inspect, and
    // account for the branch still being checked out in the writer seat (a bare
    // "delete the branch" fails while it is checked out).
    assert.match(out, /crashed before committing|before.*first commit|pre-?commit/i, 'names the pre-commit-crash cause');
    assert.match(out, /merged without a receipt|merge.*receipt.*missing|not.*recorded/i, 'ALSO names the merged-without-receipt cause (no single-cause misdiagnosis)');
    assert.match(out, /git log main\.\.baton\/wt-a\/subtask-t1/, 'points at `git log main..<branch>` to disambiguate');
    assert.match(out, /seat|worktree|checked out|checkout/i, 'remediation accounts for the branch still being checked out in the writer seat');
  });

  it('GUARD (I1 conjunction): a receipt WITHOUT is-ancestor does NOT auto-advance — the subtask is re-run, never silently skipped', async () => {
    const subtasks = [{ id: 't1', title: 'first' }, { id: 't2', title: 'second' }];
    // A receipt exists for t1, but the branch is NOT an ancestor of main (the
    // merge did not actually land — e.g. main was rewound). A receipt-ONLY
    // advance would skip t1; the required conjunction re-runs it.
    const git = pipelineGit({ mergedBranches: [] }); // is-ancestor FALSE for every branch
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks }), git, runner: undefined });
    io.superviseChild = fakeRunner(io, [...cleanSubtask(), ...cleanSubtask()]);
    io.__runner = io.superviseChild;
    seedPipelineState(io, { flavor: 'pipeline', specDigest: dedupeKey(subtasks), phaseIndex: 0, phaseCount: 2 });
    seedReceipt(io, 't1', 'baton/wt-a/subtask-t1'); // receipt present, ancestor absent

    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 0, `the run completes by re-running t1; stderr: ${io.stderrText()}`);
    const writers = writersOf(io.__runner);
    assert.ok(writers.length >= 1, 'a writer ran');
    assert.equal(valAfter(argsOf(writers[0]), '-C'), WT_A, 'the FIRST writer is t1 (wt-a) — a receipt alone did NOT skip it (is-ancestor is a required conjunct)');
  });

  it('RED (I1c): a clean merge PERSISTS a durable receipt {subtaskId, branch, mergedAt} BEFORE the phase-advance is journaled', async () => {
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;

    // Ordering hook: at each phase-advance journal write, capture whether the t1
    // receipt is ALREADY on disk (durable before the advance, not merely by EOR).
    const journalPath = `${loopPaths('/repo').dir}/journal.ndjson`;
    const receiptAtAdvance = [];
    const realAppend = io.fs.appendFileSync.bind(io.fs);
    io.fs.appendFileSync = (/** @type {any} */ path, /** @type {any} */ data) => {
      if (String(path) === journalPath && /"type":"phase-advance"/.test(String(data))) {
        receiptAtAdvance.push(receipts(io).some((r) => r.subtaskId === 't1'));
      }
      return realAppend(path, data);
    };

    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 0);
    const rec = receipts(io).find((r) => r.subtaskId === 't1');
    assert.ok(rec, 'a merge receipt is persisted after the subtask merges');
    assert.equal(rec.branch, 'baton/wt-a/subtask-t1', 'the receipt names the merged branch');
    assert.ok(typeof rec.mergedAt === 'string' && rec.mergedAt.length > 0, 'the receipt records mergedAt');
    assert.ok(receiptAtAdvance.length >= 1 && receiptAtAdvance.every(Boolean), 'the receipt is durable on disk BEFORE the phase advance is journaled (crash-safe)');
  });
});

// ===========================================================================
// I3 (A2/B4) — an EXISTING unstamped state (no flavor/specDigest) is refused by
// pipeline run, with the archive instruction, zero spawns.
describe('pipeline — I3: unstamped legacy state is refused', () => {
  it('RED (I3): an unstamped state.json (no flavor/specDigest) refuses exit 2 with the archive instruction, zero spawns', async () => {
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'a' }, { id: 't2', title: 'b' }] }), runner: undefined });
    io.superviseChild = fakeRunner(io, [...cleanSubtask(), ...cleanSubtask()]);
    io.__runner = io.superviseChild;
    io.fs.mkdirSync(loopPaths('/repo').dir, { recursive: true });
    io.fs.writeFileSync(
      loopPaths('/repo').state,
      JSON.stringify({
        schema: 'baton/loop-state@1', runId: 'legacy', goal: 'Ship the pipeline', phaseCount: 2, phaseIndex: 1,
        iterations: {}, status: 'running', parkReason: null, escalation: null, smokeApproval: null, createdAt: T0, journalSeq: 0,
        // NO flavor, NO specDigest.
      }, null, 2) + '\n',
    );
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 2, 'an unstamped state is refused, not resumed');
    assert.match(io.stderrText() + io.stdoutText(), /archive/i, 'the refusal tells the operator to archive the state');
    assert.equal(io.__runner.calls.length, 0, 'no child spawned on an unstamped-state refusal');
  });
});

// ===========================================================================
// J1 (B1) — `baton pipeline resume` mirrors G6's loop resume: PARKED -> running
// (cap counters intact), ESCALATED refused, flavor-guarded.
describe('pipeline — J1: pipeline resume', () => {
  const gate = 'subtask-t1-review';

  it('RED (J1a): resume transitions a PARKED run to running — the same subtask re-runs its writer, gate counters intact (no refund)', async () => {
    const subtasks = [{ id: 't1', title: 'only' }];
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks }), runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    // A parked run mid-subtask t1 with the gate already iterated 3 times.
    seedPipelineState(io, {
      flavor: 'pipeline', specDigest: dedupeKey(subtasks), phaseIndex: 0, phaseCount: 1,
      status: 'parked', parkReason: 'operator paused', iterations: { [gate]: 3 },
    });

    const code = await run(['pipeline', 'resume'], io);
    assert.notEqual(code, 2, 'resume is a recognized subcommand (not a usage error)');
    const writers = writersOf(io.__runner);
    assert.ok(writers.length >= 1, 'resume re-runs the parked subtask — its writer spawns again');
    assert.equal(valAfter(argsOf(writers[0]), '-C'), WT_A, 'the re-run writer is t1 in wt-a (not skipped)');
    assert.ok((await loadLoopState('/repo', io)).state.iterations[gate] >= 3, 'the gate cap counter survives resume — no refund');
    // J1a: resume must pin SUCCESSFUL continuation of the clean case, not merely
    // "not-unknown + writer respawns". The clean subtask completes: exit 0, the
    // run reaches DONE, and the journal records a RESUME event BEFORE completion.
    assert.equal(code, 0, `resume completes the clean subtask; stderr: ${io.stderrText()}`);
    assert.equal((await loadLoopState('/repo', io)).state.status, LOOP_STATUS.DONE, 'the resumed pipeline reaches DONE');
    const journal = (io.files()[loopPaths('/repo').journal] ?? '')
      .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
    const resumeIdx = journal.findIndex((e) => e.type === LOOP_EVENT.RESUME);
    assert.ok(resumeIdx >= 0, 'the resume is journaled (a RESUME event is appended)');
    const advanceIdx = journal.findIndex((e) => e.type === LOOP_EVENT.PHASE_ADVANCE);
    assert.ok(advanceIdx > resumeIdx, 'the RESUME event precedes the phase-advance that completes the run');
  });

  it('RED (J1b): resume refuses an ESCALATED run (exit 3, operator-only), zero spawns', async () => {
    const subtasks = [{ id: 't1', title: 'only' }];
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks }), runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    seedPipelineState(io, {
      flavor: 'pipeline', specDigest: dedupeKey(subtasks), phaseIndex: 0, phaseCount: 1,
      status: 'escalated', escalation: { gate, iteration: 5 },
    });
    const code = await run(['pipeline', 'resume'], io);
    assert.equal(code, 3, 'an escalated run cannot be resumed (operator-only)');
    assert.equal(io.__runner.calls.length, 0, 'resume never spawns on an escalated run');
    assert.equal((await loadLoopState('/repo', io)).state.status, LOOP_STATUS.ESCALATED, 'the run stays escalated');
  });

  it('RED (J1c): pipeline resume refuses a loop-flavored state (exit 2, flavor guard), zero spawns', async () => {
    const subtasks = [{ id: 't1', title: 'only' }];
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks }), runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    seedPipelineState(io, { flavor: 'loop', specDigest: dedupeKey(subtasks), phaseIndex: 0, phaseCount: 1, status: 'parked', parkReason: 'x' });
    const code = await run(['pipeline', 'resume'], io);
    assert.equal(code, 2, 'a loop-flavored state cannot be resumed by pipeline');
    assert.match(io.stderrText() + io.stdoutText(), /flavor|loop|mismatch/i, 'the refusal names the flavor mismatch');
    assert.equal(io.__runner.calls.length, 0, 'no child spawned on a flavor mismatch');
  });

  it('GREEN (J1d companion): `baton loop resume` still refuses a pipeline-flavored state (exit 2), zero spawns — the boundary holds both ways', async () => {
    // A loop repo (loop.json with phases) whose state was stamped by a pipeline run.
    const loopJson = { schema: 'baton/loop@1', goal: 'boundary', constraints: [], budgets: { iterationCap: 5, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 }, phases: [{ id: 'plan', role: 'planner' }, { id: 'gate-1', role: 'plan-reviewer' }] };
    const io = makePipeRepo({ spec: loopJson, runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    io.fs.mkdirSync(loopPaths('/repo').dir, { recursive: true });
    io.fs.writeFileSync(
      loopPaths('/repo').state,
      JSON.stringify({
        schema: 'baton/loop-state@1', runId: 'x', goal: 'boundary', phaseCount: 2, phaseIndex: 0,
        iterations: {}, status: 'parked', parkReason: 'x', escalation: null, smokeApproval: null, createdAt: T0, journalSeq: 0,
        flavor: 'pipeline', specDigest: dedupeKey(loopJson.phases),
      }, null, 2) + '\n',
    );
    const code = await run(['loop', 'resume'], io);
    assert.equal(code, 2, 'loop resume refuses a pipeline-flavored state');
    assert.match(io.stderrText() + io.stdoutText(), /flavor|pipeline|mismatch/i, 'the refusal names the flavor mismatch');
    assert.equal(io.__runner.calls.length, 0, 'no child spawned across the flavor boundary');
  });

  it('RED (J1e): resume with NOTHING to resume REFUSES (exit 2) and never initializes a fresh run', async () => {
    // A repo with a spec (loop.json) but NO persisted .handoff/loop/state.json —
    // e.g. `resume` run in the wrong directory. Resuming must refuse, NOT quietly
    // init a new state and launch a full pipeline from scratch.
    const io = makePipeRepo({ spec: pipelineSpec({ subtasks: [{ id: 't1', title: 'only' }] }), runner: undefined });
    io.superviseChild = fakeRunner(io, cleanSubtask());
    io.__runner = io.superviseChild;
    assert.equal(io.fs.existsSync(loopPaths('/repo').state), false, 'precondition: no persisted run state exists');

    const code = await run(['pipeline', 'resume'], io);
    assert.equal(code, 2, 'nothing to resume is a usage error, not a silent fresh run');
    const out = io.stderrText() + io.stdoutText();
    assert.match(out, /nothing to resume/i, 'the refusal states there is nothing to resume');
    assert.match(out, /baton pipeline run/, 'the refusal points at `baton pipeline run` to start a fresh run');
    assert.equal(io.__runner.calls.length, 0, 'a nothing-to-resume refusal spawns no children');
    // The teeth: a wrong-directory resume must not initialize and start over.
    assert.equal(io.fs.existsSync(loopPaths('/repo').state), false, 'refusing to resume never creates a state.json');
  });
});

function loopFile(io, name) {
  return io.files()[`${loopPaths('/repo').dir}/${name}`];
}
