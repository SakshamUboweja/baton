import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { run } from '../../core/src/cli.mjs';
import { loadLoopState, loopPaths, LOOP_STATUS } from '../../core/src/loop/state.mjs';

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

/**
 * A STRICT, stateful fake git: unstubbed commands reject; worktree add/list and
 * checkout -b are modeled so setup + preflight/postflight + merge cohere.
 * `over` overrides specific responses (e.g. a merge conflict).
 */
function pipelineGit({ over = {}, log = CLEAN_LOG } = {}) {
  const added = /** @type {Map<string,string>} */ (new Map()); // path -> branch
  const branchAt = /** @type {Map<string,string>} */ (new Map()); // cwd -> current branch
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

    if (argstr.startsWith('worktree list')) return Promise.resolve({ stdout: list(), stderr: '' });
    if (argstr.startsWith('worktree add')) {
      const path = args.find((a) => a.startsWith('/repo/.worktrees/'));
      const bi = args.indexOf('-b');
      const branch = bi >= 0 ? args[bi + 1] : 'baton/wt-x/base';
      if (path) { added.set(path, branch); branchAt.set(path, branch); }
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    if (argstr.startsWith('worktree prune') || argstr.startsWith('worktree remove')) return Promise.resolve({ stdout: '', stderr: '' });
    if (argstr.startsWith('checkout -b')) { if (opts?.cwd) branchAt.set(opts.cwd, args[args.indexOf('-b') + 1]); return Promise.resolve({ stdout: '', stderr: '' }); }
    if (argstr.startsWith('status --porcelain')) return Promise.resolve({ stdout: '', stderr: '' });
    if (argstr === 'rev-parse --abbrev-ref HEAD') return Promise.resolve({ stdout: `${branchAt.get(opts?.cwd) ?? 'main'}\n`, stderr: '' });
    if (argstr.startsWith('rev-parse')) return Promise.resolve({ stdout: `${mainSha}\n`, stderr: '' });
    if (argstr.startsWith('log ')) return Promise.resolve({ stdout: log, stderr: '' });
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

function loopFile(io, name) {
  return io.files()[`${loopPaths('/repo').dir}/${name}`];
}
