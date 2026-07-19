import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { cmdLoop } from '../../core/src/commands/loop.mjs';
import { loadLoopState, loopPaths, LOOP_STATUS } from '../../core/src/loop/state.mjs';
import { dedupeKey } from '../../core/src/util/ids.mjs';

// ---------------------------------------------------------------------------
// RED — `baton loop run` supervisor state machine (subtask loop-run). Extends
// core/src/commands/loop.mjs with the `run` subcommand that COMPOSES the loop
// modules (spec/state/children/failover) over the real command machinery.
// Source: docs/plans/2026-07-18-goal-loop-worktree-pipeline.md §"baton loop
// (Layer 2)", §"Smoke gate", §"Caps", §"Supervisor lifetime and recovery".
//
// INJECTION SEAM (pinned): the command runs children via
//   io.superviseChild ?? superviseChild
// so tests inject a scripted fake runner that returns the next queued result
// and records the {command, args, env} it was invoked with. Everything else
// drives the real modules over memfs.
//
// The `run` subcommand does not exist yet: `loop run` currently exits 2
// ("unknown subcommand 'run'"). Reds assert TARGET behavior (exit codes, spawn
// counts, persisted state, ESCALATION/SMOKE-REVIEW files) — distinguished from
// today's generic exit 2. --detach is OUT of unit scope (deferred to e2e).
//
// PINNED EXIT CODES: done 0 · awaiting-smoke-approval 0 · escalated 3 ·
// parked 4 · live-lock refusal 1 · usage error 2.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const SIG_ABS = join(repoRoot, 'core', 'data', 'signatures.v1.json');
const SIG_CONTENT = nodeFs.readFileSync(SIG_ABS, 'utf8');

const T0 = '2026-07-19T00:00:00.000Z';
const CC_LIMIT = "You've hit your session limit · resets 3pm"; // claude-code usage-limit signature
const MODEL_UNAVAIL = 'not supported when using Codex with a ChatGPT account';

const CONFIG = {
  schema: 'baton/config@1',
  roles: {
    planner: ['claude-code/claude-fable-5'],
    'plan-reviewer': ['codex/gpt-5.6-sol@xhigh', 'claude-code/claude-fable-5@xhigh'],
    'test-author': ['claude-code/claude-opus-4-8', 'codex/gpt-5.5@xhigh'],
    'test-verifier': ['codex/gpt-5.5@xhigh', 'claude-code/claude-opus-4-8'],
    implementer: ['claude-code/claude-fable-5', 'codex/gpt-5.6-sol@xhigh', 'cursor/composer'],
    'final-reviewer-a': ['codex/gpt-5.6-sol@xhigh', 'codex/gpt-5.5@xhigh'],
    'final-reviewer-b': ['claude-code/claude-fable-5@xhigh', 'claude-code/claude-opus-4-8'],
  },
  platforms: { 'claude-code': {}, codex: {}, cursor: {} },
  defaults: { 'claude-code': 'claude-fable-5', codex: 'gpt-5.6-sol', cursor: 'composer' },
};

const loopSpec = (over = {}) => ({
  schema: 'baton/loop@1',
  goal: 'Ship the loop',
  constraints: [],
  smoke: { cmd: null, expect: null },
  phases: [
    { id: 'plan', role: 'planner' },
    { id: 'gate-1', role: 'plan-reviewer' },
  ],
  budgets: { iterationCap: 5, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 },
  ...over,
});

function ownedBundle(originPlatform = 'claude-code', status = 'open') {
  return {
    schema: 'baton/bundle@1',
    bundleId: 'b_looprun00000000',
    generation: 1,
    createdAt: T0,
    updatedAt: T0,
    origin: { platform: originPlatform, model: 'm', sessionHint: 'loop-sup', unstable: false },
    task: { goal: 'Ship the loop', constraints: [], acceptance: [] },
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
 * Scripted fake child runner honoring the injection seam. Each call shifts the
 * next result off the queue, writes its logContent to opts.logPath (so the
 * command reads the transcript from the child's LOG file), and records the
 * spawn spec.
 */
function fakeRunner(io, script) {
  const queue = [...script];
  const calls = /** @type {any[]} */ ([]);
  const fn = (/** @type {any} */ spec, /** @type {any} */ opts = {}) => {
    calls.push({ spec, opts, args: spec?.args ?? [], command: spec?.command, env: spec?.env });
    const r = queue.shift() ?? { timedOut: false, exitCode: 0, verdict: 'APPROVED', findings: '' };
    // No fallback: the command MUST pass a real logPath (asserted below).
    const logPath = opts.logPath;
    if (typeof r.logContent === 'string') {
      const dir = logPath.slice(0, logPath.lastIndexOf('/'));
      io.fs.mkdirSync(dir, { recursive: true });
      io.fs.writeFileSync(logPath, r.logContent);
    }
    return Promise.resolve({ timedOut: r.timedOut ?? false, exitCode: r.exitCode ?? 0, verdict: r.verdict ?? 'APPROVED', findings: r.findings ?? '', logPath });
  };
  fn.calls = calls;
  return fn;
}

function makeLoopRepo({ spec = loopSpec(), files = {}, runner, execFile, env = {} } = {}) {
  const io = makeIo({
    now: T0,
    host: 'loop-host',
    pid: 4242,
    startTime: 111000,
    fencingSeed: 1,
    env,
    files: {
      [SIG_ABS]: SIG_CONTENT,
      '/repo/baton.config.json': JSON.stringify(CONFIG, null, 2),
      ...(spec ? { '/repo/loop.json': JSON.stringify(spec, null, 2) + '\n' } : {}),
      ...files,
    },
  });
  if (execFile) io.execFile = execFile;
  const fake = runner ?? fakeRunner(io, []);
  io.superviseChild = fake;
  io.__runner = fake;
  return io;
}

const argsOf = (io, i) => (io.__runner.calls[i]?.args ?? []).map(String);
const serialize = (io, i) => argsOf(io, i).join(' ');
const valAfter = (arr, flag) => { const i = arr.indexOf(flag); return i >= 0 ? arr[i + 1] : undefined; };
const loopFile = (io, name) => io.files()[`${loopPaths('/repo').dir}/${name}`];

// ===========================================================================
describe('loop run — preconditions', () => {
  it('no loop.json -> usage error (exit 2) naming loop.json / loop init, ZERO children spawned', async () => {
    const io = makeLoopRepo({ spec: null }); // no loop.json seeded
    const code = await cmdLoop(['run'], io);
    assert.equal(code, 2);
    assert.match(io.stderrText() + io.stdoutText(), /loop\.json|loop init/i, 'the error points at the missing spec, not a generic unknown-subcommand');
    assert.equal(io.__runner.calls.length, 0, 'no child spawned when preconditions fail');
  });

  it('an invalid spec (unknown role) -> exit 2 surfacing validateLoopSpec errors, ZERO children spawned', async () => {
    // Config MISSING plan-reviewer -> the spec references an unknown role.
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    delete cfg.roles['plan-reviewer'];
    const io = makeLoopRepo({ files: { '/repo/baton.config.json': JSON.stringify(cfg, null, 2) } });
    const code = await cmdLoop(['run'], io);
    assert.equal(code, 2);
    assert.match(io.stderrText() + io.stdoutText(), /unknown role 'plan-reviewer'/, 'the validateLoopSpec error is surfaced');
    assert.equal(io.__runner.calls.length, 0, 'no child spawned for an invalid spec');
  });
});

// ===========================================================================
describe('loop run — supervisor run lock', () => {
  it('a LIVE supervisor.lock refuses a second run (exit 1) naming the live pid', async () => {
    const io = makeLoopRepo({ execFile: undefined });
    // A different, ALIVE supervisor already holds the lock.
    io.processAlive = (p) => p === 55555;
    const p = loopPaths('/repo');
    io.fs.mkdirSync(p.dir, { recursive: true });
    io.fs.writeFileSync(`${p.dir}/supervisor.lock`, JSON.stringify({ host: 'loop-host', pid: 55555, startTime: 222, runId: 'loop-other' }));

    const code = await cmdLoop(['run'], io);
    assert.equal(code, 1, 'a live supervisor blocks a second run');
    assert.match(io.stderrText() + io.stdoutText(), /55555/, 'the refusal names the live supervisor pid');
    assert.equal(io.__runner.calls.length, 0, 'no child spawned while another supervisor is live');
  });

  it('a provably-DEAD supervisor.lock is recovered and the run proceeds', async () => {
    const io = makeLoopRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }]);
    io.__runner = io.superviseChild;
    // Default processAlive: only this io's own pid is alive; 999999 is dead.
    const p = loopPaths('/repo');
    io.fs.mkdirSync(p.dir, { recursive: true });
    io.fs.writeFileSync(`${p.dir}/supervisor.lock`, JSON.stringify({ host: 'loop-host', pid: 999999, startTime: 7, runId: 'loop-dead' }));

    const code = await cmdLoop(['run'], io);
    assert.equal(code, 0, 'a dead lock is reclaimed and the run completes');
    assert.ok(io.__runner.calls.length >= 1, 'children were spawned after recovering the dead lock');
  });
});

// ===========================================================================
describe('loop run — phase driving', () => {
  it('a 2-phase run (plan -> gate-1), both APPROVED: children on the RESOLVED assignments, status done, state persisted', async () => {
    const io = makeLoopRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }]);
    io.__runner = io.superviseChild;

    const code = await cmdLoop(['run'], io);
    assert.equal(code, 0, 'a fully-APPROVED run finishes clean');
    assert.equal(io.__runner.calls.length, 2, 'exactly one child per phase');

    // Phase 1: planner -> claude-code (chain head), headless -p.
    assert.equal(io.__runner.calls[0].command, 'claude');
    assert.ok(argsOf(io, 0).includes('-p'), 'the planner child runs headless');
    // Phase 2: plan-reviewer -> codex/gpt-5.6-sol, reviewer read-only sandbox.
    assert.equal(io.__runner.calls[1].command, 'codex');
    assert.equal(valAfter(argsOf(io, 1), '--model'), 'gpt-5.6-sol', 'the reviewer child carries the resolved model');
    assert.equal(valAfter(argsOf(io, 1), '-s'), 'read-only', 'the reviewer runs in a read-only sandbox');

    // Every spawn is given a real per-child log path under .handoff/loop/children/
    // plus its platform and timeout/grace budget.
    for (const [i] of io.__runner.calls.entries()) {
      const opts = io.__runner.calls[i].opts;
      assert.match(String(opts.logPath), /\/\.handoff\/loop\/children\//, `child ${i} log path is under .handoff/loop/children/`);
      assert.ok(typeof opts.platform === 'string' && opts.platform.length > 0, `child ${i} opts carry the platform`);
      assert.ok(typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0, `child ${i} opts carry a timeout`);
      assert.ok(typeof opts.graceMs === 'number' && opts.graceMs > 0, `child ${i} opts carry a grace period`);
    }

    const { state } = await loadLoopState('/repo', io);
    assert.equal(state.status, LOOP_STATUS.DONE, 'the run reached done');
    assert.equal(state.phaseIndex, 2, 'both phases advanced');
    assert.ok(loopFile(io, 'state.json'), 'loop state persisted under .handoff/loop');
    assert.ok(io.fs.existsSync(loopPaths('/repo').journal), 'the loop journal persisted');
  });
});

// ===========================================================================
describe('loop run — gate iteration + the 5-cap', () => {
  const gateSpec = loopSpec({ phases: [{ id: 'gate-1', role: 'plan-reviewer' }] });

  it('BLOCKED re-runs with findings in the retry prompt; the 6th attempt NEVER spawns; escalated + ESCALATION.md; exit 3', async () => {
    const io = makeLoopRepo({ spec: gateSpec, runner: undefined });
    // Six BLOCKED results queued; only five may ever be consumed.
    io.superviseChild = fakeRunner(io, [
      { verdict: 'BLOCKED', findings: 'FINDING-ALPHA-1' },
      { verdict: 'BLOCKED', findings: 'FINDING-BETA-2' },
      { verdict: 'BLOCKED', findings: 'f3' },
      { verdict: 'BLOCKED', findings: 'f4' },
      { verdict: 'BLOCKED', findings: 'f5' },
      { verdict: 'BLOCKED', findings: 'f6' },
    ]);
    io.__runner = io.superviseChild;

    const code = await cmdLoop(['run'], io);
    assert.equal(code, 3, 'escalation exits 3 (defined nonzero)');
    assert.equal(io.__runner.calls.length, 5, 'exactly five gate attempts — a 6th is never spawned');
    // Each retry carries the PRECEDING attempt's findings — later findings are
    // not dropped in favor of the first.
    assert.match(serialize(io, 1), /FINDING-ALPHA-1/, "the 2nd attempt's prompt carries the 1st attempt's findings");
    assert.match(serialize(io, 2), /FINDING-BETA-2/, "the 3rd attempt's prompt carries the 2nd attempt's findings (continuity, not just the first)");

    const { state } = await loadLoopState('/repo', io);
    assert.equal(state.status, LOOP_STATUS.ESCALATED, 'the run escalated at the cap');
    const esc = loopFile(io, 'ESCALATION.md');
    assert.ok(esc, 'an ESCALATION.md was written under .handoff/loop');
    assert.match(esc, /gate-1/, 'the escalation names the exhausted gate');
  });
});

// ===========================================================================
describe('loop run — smoke gate', () => {
  const smokeSpec = loopSpec({
    smoke: { cmd: 'npm run smoke', expect: 'ok' },
    phases: [
      { id: 'smoke-tests', role: 'test-author' },
      { id: 'smoke-verify', role: 'test-verifier' },
      { id: 'smoke-build', role: 'implementer' },
      { id: 'subtask-implement', role: 'implementer' },
    ],
  });

  function smokeExecFile(rec) {
    return (/** @type {string} */ cmd, /** @type {string[]} */ args = []) => {
      rec.push([cmd, ...args].join(' '));
      // git stays unavailable; the smoke command "passes".
      if (cmd === 'git') return Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      return Promise.resolve({ stdout: 'ok\n', stderr: '' });
    };
  }

  it('after smoke-build: runs smoke.cmd, writes SMOKE-REVIEW.md + a smoke-approval token, awaits, exit 0, no further child', async () => {
    const rec = [];
    const io = makeLoopRepo({ spec: smokeSpec, execFile: smokeExecFile(rec), runner: undefined });
    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }, { verdict: 'APPROVED' }]);
    io.__runner = io.superviseChild;

    const code = await cmdLoop(['run'], io);
    assert.equal(code, 0, 'pausing for smoke approval is a clean exit 0');
    assert.equal(io.__runner.calls.length, 3, 'the smoke slice ran (3 phases); the post-smoke phase did NOT spawn');
    assert.ok(rec.some((c) => /smoke/.test(c)), 'smoke.cmd was executed via io.execFile');

    assert.ok(loopFile(io, 'SMOKE-REVIEW.md'), 'SMOKE-REVIEW.md was written');
    const approval = loopFile(io, 'smoke-approval.json');
    assert.ok(approval, 'a smoke-approval record was written');
    const token = JSON.parse(approval).token;
    assert.ok(typeof token === 'string' && token.startsWith('smk1.'), 'the approval carries a smokeApprovalToken over the six inputs');

    const { state } = await loadLoopState('/repo', io);
    assert.equal(state.status, LOOP_STATUS.AWAITING_SMOKE_APPROVAL, 'the run is awaiting smoke approval');
  });

  it('--approve-smoke <correct token> resumes into the next phase (a child spawns again)', async () => {
    const rec = [];
    const io = makeLoopRepo({ spec: smokeSpec, execFile: smokeExecFile(rec), runner: undefined });
    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }, { verdict: 'APPROVED' }]);
    io.__runner = io.superviseChild;
    assert.equal(await cmdLoop(['run'], io), 0);
    const token = JSON.parse(loopFile(io, 'smoke-approval.json')).token;

    // Resume with the correct token — a FRESH runner for the continued phase.
    const runner2 = fakeRunner(io, [{ verdict: 'APPROVED' }]);
    io.superviseChild = runner2;
    io.__runner = runner2;
    const code = await cmdLoop(['run', '--approve-smoke', token], io);
    assert.equal(code, 0);
    assert.equal(runner2.calls.length, 1, 'a verified approval continues into the post-smoke phase');
  });

  it('--approve-smoke with the REAL issued token after a bound input drifted -> refused: exit 4, PARKED, zero spawns', async () => {
    // A git-aware execFile whose HEAD is a mutable ref — HEAD is a bound token
    // input, so moving it between issuance and approval is genuine drift.
    let head = 'HEAD-A';
    const gitAware = (/** @type {string} */ cmd, /** @type {string[]} */ args = []) => {
      if (cmd === 'git') {
        const key = args.join(' ');
        const out = key === 'rev-parse HEAD' ? head : key === 'rev-parse --abbrev-ref HEAD' ? 'main' : '';
        return Promise.resolve({ stdout: out + '\n', stderr: '' });
      }
      return Promise.resolve({ stdout: 'ok\n', stderr: '' }); // the smoke command
    };
    const io = makeLoopRepo({ spec: smokeSpec, execFile: gitAware, runner: undefined });
    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }, { verdict: 'APPROVED' }]);
    io.__runner = io.superviseChild;
    assert.equal(await cmdLoop(['run'], io), 0);
    const token = JSON.parse(loopFile(io, 'smoke-approval.json')).token; // the ACTUAL issued smk1 token

    // Drift a bound input: HEAD moves after the human looked.
    head = 'HEAD-B';
    const runner2 = fakeRunner(io, [{ verdict: 'APPROVED' }]);
    io.superviseChild = runner2;
    io.__runner = runner2;
    const code = await cmdLoop(['run', '--approve-smoke', token], io); // the OLD token, now stale
    assert.equal(code, 4, 'the plan parks on smoke-token drift');
    assert.equal(runner2.calls.length, 0, 'a drifted approval spawns no child');
    const { state } = await loadLoopState('/repo', io);
    assert.equal(state.status, LOOP_STATUS.PARKED, 'drift parks the run (not left silently awaiting)');
  });
});

// ===========================================================================
describe('loop run — failover integration', () => {
  it('a usage-limit child (limit banner in its LOG) relaunches on the NEW platform (next child argv)', async () => {
    // implementer chain: [claude-code, codex, cursor]; the claude-code child hits
    // a session limit -> failover avoids claude-code -> relaunch on codex.
    const spec = loopSpec({ phases: [{ id: 'subtask-implement', role: 'implementer' }] });
    const io = makeLoopRepo({ spec, files: { '/repo/.handoff/bundle.json': JSON.stringify(ownedBundle('claude-code', 'open'), null, 2) + '\n' }, runner: undefined });
    io.superviseChild = fakeRunner(io, [
      { verdict: 'BLOCKED', exitCode: 1, logContent: `child transcript...\n${CC_LIMIT}\n` }, // the limit lives in the LOG
      { verdict: 'APPROVED' }, // the relaunched child succeeds
    ]);
    io.__runner = io.superviseChild;

    const code = await cmdLoop(['run'], io);
    assert.equal(io.__runner.calls.length, 2, 'the failover relaunched exactly one follow-up child');
    assert.equal(io.__runner.calls[0].command, 'claude', 'the first child ran on the claude-code chain head');
    assert.equal(io.__runner.calls[1].command, 'codex', 'the relaunch ran on the failover target platform (codex)');
    assert.equal(valAfter(argsOf(io, 1), '--model'), 'gpt-5.6-sol', 'the relaunch used the resolved next-entry model');
    assert.equal(code, 0, 'the relaunched child completed the phase');
  });

  it('a failover PARK decision stops the run parked (single-entry CODEX role, model-unavailable)', async () => {
    // The model-unavailable signature is CODEX-only, and the classifier filters
    // by the child's platform — so the dead child must run on codex. A
    // single-entry codex chain exhausts after its dead model -> runFailover parks.
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.roles['solo-codex'] = ['codex/gpt-5.6-sol@xhigh'];
    const spec = loopSpec({ phases: [{ id: 'work', role: 'solo-codex' }] });
    const io = makeLoopRepo({
      spec,
      files: {
        '/repo/baton.config.json': JSON.stringify(cfg, null, 2),
        '/repo/.handoff/bundle.json': JSON.stringify(ownedBundle('codex', 'open'), null, 2) + '\n',
      },
      runner: undefined,
    });
    io.superviseChild = fakeRunner(io, [{ verdict: 'BLOCKED', exitCode: 1, logContent: `child said: ${MODEL_UNAVAIL}\n` }]);
    io.__runner = io.superviseChild;

    const code = await cmdLoop(['run'], io);
    assert.equal(io.__runner.calls.length, 1, 'no relaunch when failover parks');
    assert.equal(io.__runner.calls[0].command, 'codex', 'the dead child genuinely ran on codex (so the codex-only signature applies)');
    assert.equal(code, 4, 'a parked run exits 4 (defined nonzero)');
    const { state } = await loadLoopState('/repo', io);
    assert.equal(state.status, LOOP_STATUS.PARKED, 'the run is parked');
  });
});

// ===========================================================================
describe('loop run — recovery from a mid-run crash', () => {
  it('resumes from the journal position: only the REMAINING phase spawns a child', async () => {
    const spec = loopSpec(); // plan -> gate-1
    const io = makeLoopRepo({ spec, runner: undefined });
    // Seed a mid-run state: plan already completed (phaseIndex 1), gate-1 pending,
    // plus a matching journal and a DEAD supervisor lock.
    const p = loopPaths('/repo');
    io.fs.mkdirSync(p.dir, { recursive: true });
    const midState = {
      schema: 'baton/loop-state@1',
      runId: 'loop-prior',
      goal: 'Ship the loop',
      phaseCount: 2,
      phaseIndex: 1,
      iterations: { 'gate-1': 0 },
      status: LOOP_STATUS.RUNNING,
      parkReason: null,
      escalation: null,
      smokeApproval: null,
      createdAt: T0,
      journalSeq: 1,
      // I3 reconciliation: stamped so the resume is not refused as unstamped.
      flavor: 'loop',
      specDigest: dedupeKey(spec.phases),
    };
    io.fs.writeFileSync(p.state, JSON.stringify(midState, null, 2) + '\n');
    io.fs.writeFileSync(p.journal, JSON.stringify({ seq: 1, ts: T0, type: 'phase-advance' }) + '\n');
    io.fs.writeFileSync(`${p.dir}/supervisor.lock`, JSON.stringify({ host: 'loop-host', pid: 999999, startTime: 7, runId: 'loop-prior' }));

    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }]); // only gate-1 remains
    io.__runner = io.superviseChild;

    const code = await cmdLoop(['run'], io);
    assert.equal(io.__runner.calls.length, 1, 'the completed plan phase is NOT re-run — only gate-1 spawns');
    assert.equal(io.__runner.calls[0].command, 'codex', 'the resumed child is the gate-1 reviewer (codex)');
    assert.equal(code, 0, 'resuming the remaining phase completes the run');
    const { state } = await loadLoopState('/repo', io);
    assert.equal(state.status, LOOP_STATUS.DONE);
  });
});

// ===========================================================================
describe('loop run — strict flags & supervisor-side guard', () => {
  it('a stray positional exits 2', async () => {
    const io = makeLoopRepo();
    assert.equal(await cmdLoop(['run', 'stray'], io), 2);
  });

  it('an unknown flag exits 2', async () => {
    const io = makeLoopRepo();
    assert.equal(await cmdLoop(['run', '--no-such-flag'], io), 2);
  });

  it('--approve-smoke with no value is a usage error (exit 2) naming the flag + value, NOT "unknown flag"', async () => {
    const io = makeLoopRepo();
    const code = await cmdLoop(['run', '--approve-smoke'], io);
    assert.equal(code, 2, 'a valueless --approve-smoke must not silently run unapproved');
    const out = io.stderrText() + io.stdoutText();
    assert.match(out, /--approve-smoke/, 'the diagnostic names the flag');
    assert.match(out, /value/i, 'the diagnostic says a value is required');
    assert.doesNotMatch(out, /unknown flag/i, '--approve-smoke joins the strict spec — it is a KNOWN flag missing its value');
  });

  it('BATON_SUPERVISED_CHILD does NOT suppress loop run (supervisor-side)', async () => {
    const io = makeLoopRepo({ env: { BATON_SUPERVISED_CHILD: '1' }, runner: undefined });
    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }]);
    io.__runner = io.superviseChild;
    const code = await cmdLoop(['run'], io);
    assert.equal(code, 0, 'the guard is child-only; the supervisor command still runs');
    assert.ok(io.__runner.calls.length >= 1, 'children were spawned under the guard env');
  });
});

// ===========================================================================
// B8 (G2) — the run-lock acquisition must be ATOMIC, not check-then-write.
describe('loop run — atomic run-lock acquisition (B8)', () => {
  const DIR = `${loopPaths('/repo').dir}`;
  const LOCK = `${DIR}/supervisor.lock`;

  it('RED (B8): implementation-neutral — the competitor materializes AT the exclusive-create; wx/mkdir-first refuses, check-then-write clobbers (RED)', async () => {
    const io = makeLoopRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }]);
    io.__runner = io.superviseChild;
    io.processAlive = (p) => p === 55555; // the competitor supervisor is LIVE

    const realWrite = io.fs.writeFileSync.bind(io.fs);
    const realMkdir = io.fs.mkdirSync.bind(io.fs);
    const realRename = io.fs.renameSync.bind(io.fs);
    const COMPETITOR = JSON.stringify({ host: 'loop-host', pid: 55555, startTime: 222, runId: 'competitor' });

    // The competitor wins the lock the INSTANT before the supervisor's own write
    // to LOCK lands — injected at whichever primitive the acquire uses to create
    // it. NO readFileSync hook, so a wx/mkdir-FIRST acquire (which never reads
    // before creating) cannot dodge the race.
    let injected = false;
    const injectBefore = (/** @type {any} */ target) => {
      if (injected || String(target) !== LOCK) return;
      injected = true;
      realMkdir(DIR, { recursive: true });
      realWrite(LOCK, COMPETITOR);
    };

    // Exclusive create (flag wx/ax) enforces the O_EXCL semantics memfs lacks:
    // once the competitor exists, an exclusive write throws EEXIST.
    io.fs.writeFileSync = (/** @type {any} */ p, /** @type {any} */ data, /** @type {any} */ opts) => {
      const flag = typeof opts === 'string' ? undefined : opts?.flag;
      const exclusive = flag === 'wx' || flag === 'ax' || flag === 'wx+' || flag === 'ax+';
      injectBefore(p);
      if (exclusive && String(p) === LOCK && io.fs.existsSync(p)) throw Object.assign(new Error(`EEXIST: file already exists, open '${p}'`), { code: 'EEXIST' });
      return realWrite(p, data, opts); // a PLAIN write to LOCK clobbers the competitor
    };
    // mkdirSync(LOCK) as an exclusive lock dir: memfs already throws EEXIST when a
    // node exists at the path (the injected competitor file).
    io.fs.mkdirSync = (/** @type {any} */ p, /** @type {any} */ opts) => { injectBefore(p); return realMkdir(p, opts); };
    // A tmp+rename publish (atomicWriteJson) clobbers the competitor on rename.
    io.fs.renameSync = (/** @type {any} */ from, /** @type {any} */ to) => { injectBefore(to); return realRename(from, to); };

    const code = await cmdLoop(['run'], io);
    assert.equal(code, 1, 'a wx/mkdir-first exclusive acquire observes EEXIST and refuses the run');
    assert.equal(io.__runner.calls.length, 0, 'no child spawned when the lock was lost to the competitor');
    assert.match(JSON.parse(io.files()[LOCK]).runId, /competitor/, "the competitor's lock is not clobbered (a check-then-write path fails here)");
  });
});

// ===========================================================================
// G4 (A4) — record in-flight child groups; kill recorded orphans on reclaim.
describe('loop run — child-group recording + kill-on-reclaim (G4)', () => {
  const DIR = `${loopPaths('/repo').dir}`;

  const readChildren = (io) => {
    const raw = io.files()[`${DIR}/children.ndjson`];
    if (typeof raw !== 'string') return [];
    return raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  };

  it('RED (G4): a child-start record {childId, pid, pgid, startedAt} exists on disk WHILE the child is in flight (before completion)', async () => {
    const io = makeLoopRepo({ runner: undefined });
    let n = 0;
    const inflightOk = [];
    // The runner reports the child's group via opts.onStart (spawn time); the
    // supervisor must persist the record synchronously in that handler — BEFORE
    // the child completes — so a mid-run crash leaves the orphan reap-able.
    io.superviseChild = (/** @type {any} */ _spec, /** @type {any} */ opts) => {
      n += 1;
      const info = { pid: 8000 + n, pgid: 9000 + n };
      if (typeof opts.onStart === 'function') opts.onStart(info);
      const rec = readChildren(io).find((r) => r.pgid === info.pgid);
      inflightOk.push(
        !!rec && typeof rec.childId === 'string' && rec.childId.length > 0 && rec.pid === info.pid && typeof rec.startedAt === 'string' && rec.startedAt.length > 0,
      );
      return Promise.resolve({ timedOut: false, exitCode: 0, verdict: 'APPROVED', findings: '', logPath: opts.logPath, ...info });
    };
    const code = await cmdLoop(['run'], io);
    assert.equal(code, 0);
    assert.ok(inflightOk.length >= 1, 'at least one child ran');
    assert.ok(inflightOk.every(Boolean), 'each child-start record ({childId,pid,pgid,startedAt}) existed on disk while its child was in flight');
  });

  it('RED (G5/G4): on dead-lock reclaim, a still-alive recorded orphan group is KILLED (io.processKill) BEFORE the first new spawn', async () => {
    const io = makeLoopRepo({ runner: undefined });
    const events = []; // ordered: kills and spawns interleaved
    io.processKill = (/** @type {number} */ pid, /** @type {any} */ sig) => { events.push({ kind: 'kill', pid, sig }); return true; };
    const baseRunner = fakeRunner(io, [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }]);
    io.superviseChild = (/** @type {any} */ spec, /** @type {any} */ opts) => { events.push({ kind: 'spawn' }); return baseRunner(spec, opts); };
    io.__runner = baseRunner;
    // The dead supervisor's orphan group (pgid 9001) is still alive; its lock is dead.
    io.processAlive = (/** @type {number} */ p) => p === 9001;
    io.fs.mkdirSync(DIR, { recursive: true });
    io.fs.writeFileSync(`${DIR}/supervisor.lock`, JSON.stringify({ host: 'loop-host', pid: 999999, startTime: 7, runId: 'crashed' }));
    io.fs.writeFileSync(`${DIR}/children.ndjson`, JSON.stringify({ childId: '001-plan', pid: 8001, pgid: 9001, startedAt: T0 }) + '\n');

    const code = await cmdLoop(['run'], io);
    assert.equal(code, 0, `the reclaiming run completes after reaping orphans; stderr: ${io.stderrText()}`);
    const firstSpawn = events.findIndex((e) => e.kind === 'spawn');
    const killIdx = events.findIndex((e) => e.kind === 'kill' && Math.abs(e.pid) === 9001);
    assert.ok(killIdx >= 0, `the orphan group 9001 was killed on reclaim; events: ${JSON.stringify(events)}`);
    assert.ok(firstSpawn === -1 || killIdx < firstSpawn, 'the orphan group was killed BEFORE the first new child spawned');
  });
});

// ===========================================================================
// G6 (B6) — `baton loop resume`: PARKED -> running; ESCALATED refused.
describe('loop run — resume (G6)', () => {
  const DIR = `${loopPaths('/repo').dir}`;
  const seedState = (over) => ({
    schema: 'baton/loop-state@1',
    runId: 'loop-r',
    goal: 'Ship the loop',
    phaseCount: 2,
    phaseIndex: 0,
    iterations: {},
    status: 'running',
    parkReason: null,
    escalation: null,
    smokeApproval: null,
    createdAt: T0,
    journalSeq: 0,
    // I3 reconciliation: stamped so a valid resume is not refused as unstamped.
    flavor: 'loop',
    specDigest: dedupeKey(loopSpec().phases),
    ...over,
  });

  it('RED (G6): `baton loop resume` transitions a PARKED run back to running and continues (spawns the pending phase)', async () => {
    const io = makeLoopRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }]);
    io.__runner = io.superviseChild;
    io.fs.mkdirSync(DIR, { recursive: true });
    io.fs.writeFileSync(`${DIR}/state.json`, JSON.stringify(seedState({ status: 'parked', parkReason: 'operator paused' }), null, 2) + '\n');

    const code = await cmdLoop(['resume'], io);
    assert.equal(code, 0, `resume continues a parked run; stderr: ${io.stderrText()}`);
    assert.ok(io.__runner.calls.length >= 1, 'resume spawned the pending phase');
    assert.equal((await loadLoopState('/repo', io)).state.status, LOOP_STATUS.DONE, 'the resumed run completes');
  });

  it('RED (G6): resume on an ESCALATED run is REFUSED (escalation stays operator-only, no spawn)', async () => {
    const io = makeLoopRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }]);
    io.__runner = io.superviseChild;
    io.fs.mkdirSync(DIR, { recursive: true });
    io.fs.writeFileSync(`${DIR}/state.json`, JSON.stringify(seedState({ status: 'escalated', escalation: { gate: 'gate-1', iteration: 5 } }), null, 2) + '\n');

    const code = await cmdLoop(['resume'], io);
    assert.notEqual(code, 0, 'an escalated run cannot be resumed');
    assert.match(io.stderrText() + io.stdoutText(), /escalat|operator/i, 'the refusal explains escalation is operator-only');
    assert.equal(io.__runner.calls.length, 0, 'resume never spawns on an escalated run');
    assert.equal((await loadLoopState('/repo', io)).state.status, LOOP_STATUS.ESCALATED, 'the run stays escalated');
  });

  it('RED (G6): resume with NOTHING to resume REFUSES (exit 2) and never initializes a fresh run', async () => {
    // A loop repo with loop.json but NO persisted state.json — e.g. `resume` run
    // in the wrong directory. It must refuse, not init a fresh run from phase 0.
    const io = makeLoopRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }]);
    io.__runner = io.superviseChild;
    assert.equal(io.fs.existsSync(`${DIR}/state.json`), false, 'precondition: no persisted run state exists');

    const code = await cmdLoop(['resume'], io);
    assert.equal(code, 2, 'nothing to resume is a usage error, not a silent fresh run');
    const out = io.stderrText() + io.stdoutText();
    assert.match(out, /nothing to resume/i, 'the refusal states there is nothing to resume');
    assert.match(out, /baton loop run/, 'the refusal points at `baton loop run` to start a fresh run');
    assert.equal(io.__runner.calls.length, 0, 'a nothing-to-resume refusal spawns no children');
    // The teeth: a wrong-directory resume must not initialize and start over.
    assert.equal(io.fs.existsSync(`${DIR}/state.json`), false, 'refusing to resume never creates a state.json');
    assert.ok(!io.fs.existsSync(`${DIR}/supervisor.lock`), 'the nothing-to-resume refusal leaves no supervisor.lock behind (I4)');
  });

  it('RED (G6): `baton loop run` on a PARKED run refuses (exit 4) AND points at `resume with: baton loop resume` (symmetry with pipeline)', async () => {
    const io = makeLoopRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }]);
    io.__runner = io.superviseChild;
    io.fs.mkdirSync(DIR, { recursive: true });
    io.fs.writeFileSync(`${DIR}/state.json`, JSON.stringify(seedState({ status: 'parked', parkReason: 'operator paused' }), null, 2) + '\n');

    const code = await cmdLoop(['run'], io);
    assert.equal(code, 4, 'a plain `run` on a parked state refuses with the parked exit code');
    const out = io.stderrText() + io.stdoutText();
    assert.match(out, /parked/i, 'the refusal says the run is parked');
    assert.match(out, /resume with: baton loop resume/, 'the refusal points at the resume command (pipeline already carries this pointer — pin the symmetry)');
    assert.equal(io.__runner.calls.length, 0, 'a `run` on a parked state spawns nothing');
    assert.equal((await loadLoopState('/repo', io)).state.status, LOOP_STATUS.PARKED, 'the run stays parked (run never resumes it)');
  });
});

// ===========================================================================
// H3 (A2/B5) — children.ndjson RETIRES completed children; reclaim kills only
// still-in-flight groups (never an OS-recycled pid of a retired child).
describe('loop run — child registry retirement (H3)', () => {
  const DIR = `${loopPaths('/repo').dir}`;
  const readChildren = (io) => {
    const raw = io.files()[`${DIR}/children.ndjson`];
    if (typeof raw !== 'string') return [];
    return raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  };

  it('RED (H3a): after a clean run, EVERY started child has a matching retire record ({childId, endedAt})', async () => {
    const io = makeLoopRepo({ runner: undefined });
    // A runner that reports its group (so the supervisor writes the START record
    // via its onStart handler); the RETIRE record is the supervisor's job on resolve.
    let n = 0;
    const notRetiredAtStart = [];
    io.superviseChild = (/** @type {any} */ _spec, /** @type {any} */ opts) => {
      n += 1;
      const pgid = 9000 + n;
      if (typeof opts.onStart === 'function') opts.onStart({ pid: 8000 + n, pgid });
      // Ordering: the child is IN FLIGHT here — it must have a start record and
      // NO retire yet (retirement happens only on resolution).
      const start = readChildren(io).find((r) => r.pgid === pgid);
      const retiredEarly = readChildren(io).some((r) => start && r.childId === start.childId && typeof r.endedAt === 'string');
      notRetiredAtStart.push(!!start && !retiredEarly);
      return Promise.resolve({ timedOut: false, exitCode: 0, verdict: 'APPROVED', findings: '', logPath: opts.logPath, pgid });
    };
    io.__runner = { calls: [] };
    const code = await cmdLoop(['run'], io);
    assert.ok(notRetiredAtStart.length >= 1 && notRetiredAtStart.every(Boolean), 'a just-started child has a start record and NO endedAt while in flight');
    assert.equal(code, 0);
    const recs = readChildren(io);
    const started = recs.filter((r) => typeof r.pgid === 'number').map((r) => r.childId);
    const retired = recs.filter((r) => typeof r.endedAt === 'string').map((r) => r.childId);
    assert.ok(started.length >= 1, 'at least one child started');
    for (const id of started) assert.ok(retired.includes(id), `child ${id} was retired (a {childId, endedAt} record exists)`);
  });

  it('RED (H3b): a dead-lock reclaim KILLS NOTHING for a RETIRED child, even when processAlive says its (recycled) pgid is alive', async () => {
    const io = makeLoopRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }]);
    io.__runner = io.superviseChild;
    const killCalls = [];
    io.processKill = (/** @type {number} */ pid, /** @type {any} */ sig) => { killCalls.push({ pid, sig }); return true; };
    // The prior run's child is RETIRED, but its pgid was recycled by an unrelated live process.
    io.processAlive = (/** @type {number} */ p) => p === 9001;
    io.fs.mkdirSync(DIR, { recursive: true });
    io.fs.writeFileSync(`${DIR}/supervisor.lock`, JSON.stringify({ host: 'loop-host', pid: 999999, startTime: 7, runId: 'crashed' }));
    io.fs.writeFileSync(
      `${DIR}/children.ndjson`,
      JSON.stringify({ childId: '001-plan', pid: 8001, pgid: 9001, startedAt: T0 }) + '\n' + JSON.stringify({ childId: '001-plan', endedAt: T0 }) + '\n',
    );

    const code = await cmdLoop(['run'], io);
    assert.equal(code, 0, `the reclaiming run completes; stderr: ${io.stderrText()}`);
    assert.ok(!killCalls.some((k) => Math.abs(k.pid) === 9001), `a retired child is never killed (pid-reuse safety); kills: ${JSON.stringify(killCalls)}`);
  });
});

// ===========================================================================
// H5 (B4) vice-versa — a pipeline-flavored state is refused by `loop run`.
describe('loop run — state flavor binding (H5)', () => {
  const DIR = `${loopPaths('/repo').dir}`;
  it('RED (H5): a state.json created by `pipeline run` (flavor pipeline) is REFUSED by loop run (exit 2), zero spawns', async () => {
    const io = makeLoopRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }]);
    io.__runner = io.superviseChild;
    io.fs.mkdirSync(DIR, { recursive: true });
    io.fs.writeFileSync(
      `${DIR}/state.json`,
      JSON.stringify({
        schema: 'baton/loop-state@1', runId: 'loop-seeded', goal: 'Ship the loop', phaseCount: 2, phaseIndex: 0,
        iterations: {}, status: 'running', parkReason: null, escalation: null, smokeApproval: null, createdAt: T0, journalSeq: 0,
        flavor: 'pipeline',
      }, null, 2) + '\n',
    );
    const code = await cmdLoop(['run'], io);
    assert.equal(code, 2, 'a pipeline-flavored state cannot be resumed as a loop');
    assert.match(io.stderrText() + io.stdoutText(), /flavor|pipeline|mismatch/i, 'the refusal names the flavor mismatch');
    assert.equal(io.__runner.calls.length, 0, 'no child spawned on a flavor mismatch');
    assert.ok(!io.fs.existsSync(`${DIR}/supervisor.lock`), 'the flavor-mismatch refusal leaves no supervisor.lock behind (I4)');
  });

  it('RED (H5): a resume whose specDigest was computed over DIFFERENT phases REFUSES (exit 2), zero spawns', async () => {
    // The current loop.json has plan -> gate-1; the seeded state was digested over
    // a different phase list, so resuming its phaseIndex would misalign.
    const io = makeLoopRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }]);
    io.__runner = io.superviseChild;
    const oldPhases = [{ id: 'plan', role: 'planner' }, { id: 'REMOVED', role: 'plan-reviewer' }, { id: 'gate-1', role: 'plan-reviewer' }];
    io.fs.mkdirSync(DIR, { recursive: true });
    io.fs.writeFileSync(
      `${DIR}/state.json`,
      JSON.stringify({
        schema: 'baton/loop-state@1', runId: 'loop-seeded', goal: 'Ship the loop', phaseCount: 2, phaseIndex: 1,
        iterations: {}, status: 'running', parkReason: null, escalation: null, smokeApproval: null, createdAt: T0, journalSeq: 0,
        flavor: 'loop', specDigest: dedupeKey(oldPhases),
      }, null, 2) + '\n',
    );
    const code = await cmdLoop(['run'], io);
    assert.equal(code, 2, 'a resume against a changed phase list refuses rather than misaligning');
    assert.match(io.stderrText() + io.stdoutText(), /phase|spec|changed|digest/i, 'the refusal names the spec change');
    assert.equal(io.__runner.calls.length, 0, 'no child spawned on a spec-digest mismatch');
    assert.ok(!io.fs.existsSync(`${DIR}/supervisor.lock`), 'the spec-digest refusal leaves no supervisor.lock behind (I4)');
  });
});

// ===========================================================================
// H6 (B6) — ESCALATION.md must not instruct `baton loop run` as remediation.
describe('loop run — ESCALATION.md wording (H6)', () => {
  const DIR = `${loopPaths('/repo').dir}`;
  it('RED (H6): a resume that is already at the cap escalates with operator wording, NOT "baton loop run"', async () => {
    const spec = loopSpec({ phases: [{ id: 'gate-1', role: 'plan-reviewer' }] });
    const io = makeLoopRepo({ spec, runner: undefined });
    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }]);
    io.__runner = io.superviseChild;
    // Resume with the gate ALREADY at the 5-cap: the top-of-loop cap gate fires.
    io.fs.mkdirSync(DIR, { recursive: true });
    io.fs.writeFileSync(
      `${DIR}/state.json`,
      JSON.stringify({
        schema: 'baton/loop-state@1', runId: 'loop-seeded', goal: 'Ship the loop', phaseCount: 1, phaseIndex: 0,
        iterations: { 'gate-1': 5 }, status: 'running', parkReason: null, escalation: null, smokeApproval: null, createdAt: T0, journalSeq: 0,
        flavor: 'loop', specDigest: dedupeKey(spec.phases), // I3 reconciliation: stamped so it reaches the cap gate, not a stamp refusal
      }, null, 2) + '\n',
    );
    const code = await cmdLoop(['run'], io);
    assert.equal(code, 3, 'an at-cap gate escalates');
    const esc = loopFile(io, 'ESCALATION.md');
    assert.ok(esc, 'ESCALATION.md was written');
    assert.doesNotMatch(esc, /baton loop run/, 'the escalation must NOT tell the operator to re-run the loop (escalation is operator-only)');
    assert.match(esc, /operator|resolve the findings|escalat/i, 'the escalation uses operator remediation wording');
  });
});

// ===========================================================================
// H8 (B8b) — the run-lock runId matches the state runId while children spawn.
describe('loop run — lock runId correlates with state runId (H8)', () => {
  const DIR = `${loopPaths('/repo').dir}`;
  it('RED (H8): the supervisor.lock runId equals state.runId by the time the first child spawns', async () => {
    const io = makeLoopRepo({ runner: undefined });
    let lockRunIdAtSpawn = null;
    const base = fakeRunner(io, [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }]);
    io.superviseChild = (/** @type {any} */ spec, /** @type {any} */ opts) => {
      if (lockRunIdAtSpawn === null) {
        const raw = io.files()[`${DIR}/supervisor.lock`];
        lockRunIdAtSpawn = raw ? JSON.parse(raw).runId : 'no-lock';
      }
      return base(spec, opts);
    };
    io.__runner = base;
    const code = await cmdLoop(['run'], io);
    assert.equal(code, 0);
    const stateRunId = (await loadLoopState('/repo', io)).state.runId;
    assert.equal(lockRunIdAtSpawn, stateRunId, `the lock runId matches the state runId at spawn time (got lock=${lockRunIdAtSpawn}, state=${stateRunId})`);
  });
});

// ===========================================================================
// I2 (B2) — retire records must not mask a SAME-childId in-flight child across
// invocations; the registry is truncated on each successful acquisition.
describe('loop run — retire records never mask a resumed in-flight child (I2)', () => {
  const DIR = `${loopPaths('/repo').dir}`;

  it('RED (I2a): run 1 retired childId X; run 2 has a FRESH in-flight X (no retire) + dead lock -> reclaim MUST kill X', async () => {
    const io = makeLoopRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }]);
    io.__runner = io.superviseChild;
    const killCalls = [];
    io.processKill = (/** @type {number} */ pid, /** @type {any} */ sig) => { killCalls.push({ pid, sig }); return true; };
    // The resumed run's in-flight child (pgid 9002) is alive; run 1's retired X is not.
    io.processAlive = (/** @type {number} */ p) => p === 9002;
    io.fs.mkdirSync(DIR, { recursive: true });
    io.fs.writeFileSync(`${DIR}/supervisor.lock`, JSON.stringify({ host: 'loop-host', pid: 999999, startTime: 7, runId: 'crashed' }));
    io.fs.writeFileSync(
      `${DIR}/children.ndjson`,
      // Run 1: childId '001-plan' started (pgid 9001) then retired.
      JSON.stringify({ childId: '001-plan', pid: 8001, pgid: 9001, startedAt: T0 }) + '\n' +
        JSON.stringify({ childId: '001-plan', endedAt: T0 }) + '\n' +
        // Run 2 (the crashed resume): the SAME childId '001-plan' started again (pgid 9002), never retired.
        JSON.stringify({ childId: '001-plan', pid: 8002, pgid: 9002, startedAt: T0 }) + '\n',
    );

    const code = await cmdLoop(['run'], io);
    assert.equal(code, 0, `the reclaiming run completes; stderr: ${io.stderrText()}`);
    assert.ok(killCalls.some((k) => Math.abs(k.pid) === 9002), `the resumed in-flight X (9002) is killed despite an earlier retire of the same childId; kills: ${JSON.stringify(killCalls)}`);
  });

  it('RED (I2b): a NORMAL (non-reclaim) acquisition truncates prior-invocation records — a stale retire cannot linger to mask a future child', async () => {
    const io = makeLoopRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }]);
    io.__runner = io.superviseChild;
    // A prior invocation's stale records (a distinctive pgid 4242000) are present;
    // no lock, so this is a clean acquisition.
    io.fs.mkdirSync(DIR, { recursive: true });
    io.fs.writeFileSync(
      `${DIR}/children.ndjson`,
      JSON.stringify({ childId: '001-plan', pid: 4242000, pgid: 4242000, startedAt: T0 }) + '\n' + JSON.stringify({ childId: '001-plan', endedAt: T0 }) + '\n',
    );
    const code = await cmdLoop(['run'], io);
    assert.equal(code, 0);
    const raw = io.files()[`${DIR}/children.ndjson`] ?? '';
    assert.doesNotMatch(raw, /4242000/, "a prior invocation's records are truncated at acquisition — they cannot mask a current child");
  });
});

// ===========================================================================
// I3 (A2/B4) — an EXISTING unstamped state (no flavor/specDigest) is refused,
// with the archive instruction; I4 — the refusal leaves no lock behind.
describe('loop run — unstamped legacy state is refused (I3 + I4)', () => {
  const DIR = `${loopPaths('/repo').dir}`;
  it('RED (I3/I4): an unstamped state.json (no flavor/specDigest) refuses exit 2 with the archive instruction, zero spawns, no leaked lock', async () => {
    const io = makeLoopRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }]);
    io.__runner = io.superviseChild;
    io.fs.mkdirSync(DIR, { recursive: true });
    io.fs.writeFileSync(
      `${DIR}/state.json`,
      JSON.stringify({
        schema: 'baton/loop-state@1', runId: 'legacy', goal: 'Ship the loop', phaseCount: 2, phaseIndex: 1,
        iterations: {}, status: 'running', parkReason: null, escalation: null, smokeApproval: null, createdAt: T0, journalSeq: 0,
        // NO flavor, NO specDigest — a pre-stamp/stripped legacy state.
      }, null, 2) + '\n',
    );
    const code = await cmdLoop(['run'], io);
    assert.equal(code, 2, 'an unstamped state is a mismatch — refused, not grandfathered');
    assert.match(io.stderrText() + io.stdoutText(), /archive/i, 'the refusal tells the operator to archive the state');
    assert.equal(io.__runner.calls.length, 0, 'no child spawned on an unstamped-state refusal');
    assert.ok(!io.fs.existsSync(`${DIR}/supervisor.lock`), 'the refusal leaves no supervisor.lock behind (I4)');
  });
});

// ===========================================================================
// I5 (B5) — the run lock passes startTime to processAlive: a recycled pid
// (alive by pid alone but failing the pid+startTime pair) is reclaimed, not
// refused as live.
describe('loop run — lock reclaim uses pid+startTime (I5)', () => {
  const DIR = `${loopPaths('/repo').dir}`;
  it('RED (I5): a lock whose pid is alive by a 1-arg check but fails the (pid, startTime) pair is treated as DEAD and reclaimed', async () => {
    const io = makeLoopRepo({ runner: undefined });
    io.superviseChild = fakeRunner(io, [{ verdict: 'APPROVED' }, { verdict: 'APPROVED' }]);
    io.__runner = io.superviseChild;
    // pid 7777 reads as alive for ANY defined startTime EXCEPT the recorded 999
    // (which is the reused-pid case → dead). A 1-arg check, or a wrong-but-defined
    // second arg, would read live and wedge the lock. Only passing the RECORDED
    // startTime (999) reclaims — so the fake is inverted vs. a "match one value"
    // trap, and the calls are recorded to prove the pair is passed through.
    const aliveCalls = [];
    io.processAlive = (/** @type {number} */ pid, /** @type {number | undefined} */ startTime) => {
      aliveCalls.push({ pid, startTime });
      if (pid !== 7777) return false;
      return startTime !== 999; // dead ONLY for the recorded (pid, startTime) pair
    };
    io.fs.mkdirSync(DIR, { recursive: true });
    io.fs.writeFileSync(`${DIR}/supervisor.lock`, JSON.stringify({ host: 'loop-host', pid: 7777, startTime: 999, runId: 'recycled' }));

    const code = await cmdLoop(['run'], io);
    assert.equal(code, 0, `a reused-pid lock is reclaimed (not refused as live); stderr: ${io.stderrText()}`);
    assert.ok(io.__runner.calls.length >= 1, 'the run proceeds after reclaiming the reused-pid lock');
    assert.ok(
      aliveCalls.some((c) => c.pid === 7777 && c.startTime === 999),
      `the reclaim passes the RECORDED (pid, startTime) pair to processAlive; calls: ${JSON.stringify(aliveCalls)}`,
    );
  });
});
