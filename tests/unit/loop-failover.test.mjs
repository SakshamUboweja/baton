import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { loadConfig } from '../../core/src/roles/matrix.mjs';
import { loadBundle, bundlePaths } from '../../core/src/bundle/store.mjs';

// ---------------------------------------------------------------------------
// RED — loop limit/model failover orchestration (subtask loop-failover). NEW
// module; these tests DEFINE the API and drive the REAL command machinery
// (checkpoint/finalize/receive txn + resolveRoles) underneath, over memfs with
// seeded bundle fixtures (mirrors tests/integration/e2e-failover.test.mjs, but
// unit-level over the injected io). Source of truth:
// docs/plans/2026-07-18-goal-loop-worktree-pipeline.md §"Limit failover
// (Gate-1 iteration 1, finding 3)" + §"Model-level failover".
//
// TARGET MODULE: core/src/loop/failover.mjs.
//
// PINNED EXPORT (implementer follows): runFailover(input) -> Promise<decision>
//   input = { root, io, config, role, assignment, transcript, exitCode,
//             sessionHint, probes, avoid, avoidEntries, attempt, loopState,
//             degradedOpen? }
//     degradedOpen (default false): the supervisor could NOT cleanly seal (a
//     prior limit death left the bundle unsealed). runFailover then SKIPS
//     finalize and takes receive's degraded-open path (no .finalize.json freeze;
//     the receive generates a degraded seal). The default alive path checkpoints
//     -> finalize (seals) -> sealed receive.
//   decision = { action: 'retry'|'park'|'relaunch', class, ... }:
//     retry     -> { action:'retry', class, attempt }
//     park      -> { action:'park', class, reason, resumeAt? }
//     relaunch  -> { action:'relaunch', class, assignment, avoidEntries?, prompt? }
//
// Window drift (finding 5) is expressed purely through io.execFile SEQUENCING
// (git rev-parse HEAD returning different values on successive calls) — the
// production receive path re-derives git for prepare and for commit, so a HEAD
// change between them stales the token. There is NO test-only hook.
//
// RED MECHANISM: dynamic-import-with-catch + M() guard (meaningful reds).
// ---------------------------------------------------------------------------

let mod = /** @type {any} */ (null);
let importError = /** @type {any} */ (null);
try {
  mod = await import('../../core/src/loop/failover.mjs');
} catch (e) {
  importError = e;
}
function M() {
  assert.ok(mod, `core/src/loop/failover.mjs must load (import error: ${importError?.message ?? 'none'})`);
  return mod;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
// The shipped signatures file, seeded INTO memfs at the absolute path the module
// resolves via import.meta.url, so finalize/receive/classify find it over memfs.
const SIG_ABS = join(repoRoot, 'core', 'data', 'signatures.v1.json');
const SIG_CONTENT = nodeFs.readFileSync(SIG_ABS, 'utf8');

const T0 = '2026-07-19T00:00:00.000Z';
const GOAL = 'Ship the failover';
const CODEX_LIMIT = "You've hit your usage limit"; // codex usage-limit signature
const CODEX_LIMIT_HINT = "You've hit your usage limit. Please try again at 6:00 PM."; // + resetHint
const MODEL_UNAVAIL = 'not supported when using Codex with a ChatGPT account';
// A sentinel identifying the CHECKPOINTED loop position; ABSENT from the seed
// bundle (finding 1 — do not key on 'run1', which the seed origin already holds).
const POSITION_SENTINEL = 'LOOPPOS-SENTINEL-Q7X';

const CONFIG = {
  schema: 'baton/config@1',
  roles: {
    planner: ['claude-code/claude-fable-5'],
    // Chain STARTS with the dead codex platform, non-codex second entry (finding 2).
    'plan-reviewer': ['codex/gpt-5.6-sol@xhigh', 'claude-code/claude-fable-5@xhigh'],
    'test-author': ['claude-code/claude-opus-4-8', 'codex/gpt-5.5@xhigh'],
    'test-verifier': ['codex/gpt-5.5@xhigh', 'claude-code/claude-opus-4-8'],
    implementer: ['claude-code/claude-fable-5', 'codex/gpt-5.6-sol@xhigh', 'cursor/composer'],
    // Two codex entries — same-platform next-entry for the model-unavailable case.
    'final-reviewer-a': ['codex/gpt-5.6-sol@xhigh', 'codex/gpt-5.5@xhigh'],
    'final-reviewer-b': ['claude-code/claude-fable-5@xhigh', 'claude-code/claude-opus-4-8'],
  },
  platforms: { 'claude-code': {}, codex: {}, cursor: {} },
  defaults: { 'claude-code': 'claude-fable-5', codex: 'gpt-5.6-sol', cursor: 'composer' },
};

// The shipped table, optionally augmented with fixture-only signatures (finding 4).
function sigContentWith(extra = []) {
  if (extra.length === 0) return SIG_CONTENT;
  const t = JSON.parse(SIG_CONTENT);
  t.signatures = [...t.signatures, ...extra];
  return JSON.stringify(t);
}

function bundleFixture({ status = 'open', originPlatform = 'codex', overrides = {} } = {}) {
  return {
    schema: 'baton/bundle@1',
    bundleId: 'b_failover0000000',
    generation: 1,
    createdAt: T0,
    updatedAt: T0,
    origin: { platform: originPlatform, model: 'm', sessionHint: 'loop-run1', unstable: false },
    task: { goal: GOAL, constraints: [], acceptance: [] },
    plan: { steps: [{ id: 's1', title: 'Continue', status: 'active', note: null }] },
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
    ...overrides,
  };
}

function makeRepoIo({ status = 'open', originPlatform = 'codex', overrides = {}, execFile, extraSignatures = [] } = {}) {
  const io = makeIo({
    now: T0,
    host: 'loop-host',
    pid: 4242,
    startTime: 111000,
    fencingSeed: 1,
    files: {
      [SIG_ABS]: sigContentWith(extraSignatures),
      '/repo/baton.config.json': JSON.stringify(CONFIG, null, 2),
      '/repo/.handoff/bundle.json': JSON.stringify(bundleFixture({ status, originPlatform, overrides }), null, 2) + '\n',
    },
  });
  if (execFile) io.execFile = execFile;
  return io;
}

const parsedConfig = (io) => loadConfig('/repo', io).config;
const asg = (platform, role, model, effort = null) => ({ platform, role, model, effort, mode: platform === 'codex' ? 'native' : 'delegated' });

// A git execFile whose HEAD is chosen per rev-parse-HEAD call (the drift seam),
// and which counts those calls so a test can pin the exact number of
// prepare->commit windows. gitSnapshot reads clean status/diffs.
function gitExec(headForCall) {
  let headCalls = 0;
  const fn = (/** @type {string} */ cmd, /** @type {string[]} */ args = []) => {
    if (cmd !== 'git') return Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    const key = args.join(' ');
    if (key === 'rev-parse HEAD') {
      headCalls += 1;
      return Promise.resolve({ stdout: headForCall(headCalls) + '\n', stderr: '' });
    }
    const out = key === 'rev-parse --abbrev-ref HEAD' ? 'main' : '';
    return Promise.resolve({ stdout: out + '\n', stderr: '' });
  };
  fn.headCalls = () => headCalls;
  return fn;
}

// Spy every write touching .handoff/loop.
function spyLoopWrites(io) {
  const writes = /** @type {string[]} */ ([]);
  const note = (/** @type {any} */ p) => { if (typeof p === 'string' && p.startsWith('/repo/.handoff/loop')) writes.push(p); };
  for (const m of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'unlinkSync', 'rmSync']) {
    const real = io.fs[m].bind(io.fs);
    io.fs[m] = (/** @type {any} */ p, /** @type {any} */ a) => { note(p); return real(p, a); };
  }
  for (const m of ['renameSync', 'copyFileSync']) {
    const real = io.fs[m].bind(io.fs);
    io.fs[m] = (/** @type {any} */ from, /** @type {any} */ to) => { note(from); note(to); return real(from, to); };
  }
  return writes;
}

const historyFreezes = (io) => {
  const dir = bundlePaths('/repo').historyDir;
  if (!io.fs.existsSync(dir)) return [];
  // Parse ONLY snapshot freezes (.json). rotateJournalIn also writes .ndjson
  // journal freezes here — legitimately empty or multi-line — which are not JSON.
  return io.fs
    .readdirSync(dir)
    .filter((/** @type {string} */ n) => n.endsWith('.json'))
    .map((/** @type {string} */ n) => ({ name: n, data: JSON.parse(io.fs.readFileSync(`${dir}/${n}`, 'utf8')) }));
};

// A base input for a usage-limit failover of the `implementer` role on codex.
function usageLimitInput(io, over = {}) {
  return {
    root: '/repo',
    io,
    config: parsedConfig(io),
    role: 'implementer',
    assignment: asg('codex', 'implementer', 'gpt-5.6-sol', 'xhigh'),
    transcript: CODEX_LIMIT,
    exitCode: 1,
    sessionHint: 'loop-run1',
    probes: null,
    avoid: [],
    avoidEntries: [],
    attempt: 1,
    loopState: { runId: 'run1', phaseIndex: 7, gate: 'subtask-review', note: POSITION_SENTINEL },
    ...over,
  };
}

// ===========================================================================
describe('runFailover — non-limit exits: retry once, then park', () => {
  it('other-error on the FIRST attempt -> {action:retry}', async () => {
    const { runFailover } = M();
    const io = makeRepoIo();
    const d = await runFailover(usageLimitInput(io, { transcript: 'Error: build failed with 3 errors', exitCode: 1, attempt: 1 }));
    assert.equal(d.class, 'other-error');
    assert.equal(d.action, 'retry', 'a generic failure retries once');
  });

  it('other-error on the SECOND attempt -> {action:park} (retry-once-then-park)', async () => {
    const { runFailover } = M();
    const io = makeRepoIo();
    const d = await runFailover(usageLimitInput(io, { transcript: 'Error: build failed', exitCode: 1, attempt: 2 }));
    assert.equal(d.class, 'other-error');
    assert.equal(d.action, 'park', 'a second consecutive generic failure parks');
    assert.ok(typeof d.reason === 'string' && d.reason.length > 0, 'the park records a reason');
  });

  it('a non-limit failure NEVER seals or receives (no bundle transition)', async () => {
    const { runFailover } = M();
    const io = makeRepoIo();
    await runFailover(usageLimitInput(io, { transcript: 'Error: build failed', exitCode: 1, attempt: 1 }));
    const live = loadBundle('/repo', io).bundle;
    assert.equal(live.generation, 1, 'no generation opened for a non-limit failure');
    assert.equal(historyFreezes(io).length, 0, 'no seal/receive freeze for a non-limit failure');
  });
});

// ===========================================================================
describe('runFailover — model-unavailable: entry-level avoid + re-resolve, no seal/receive', () => {
  it('adds the dead {platform,model} to avoidEntries and relaunches the NEXT entry on the SAME platform', async () => {
    const { runFailover } = M();
    const io = makeRepoIo();
    // final-reviewer-a chain is [codex/gpt-5.6-sol, codex/gpt-5.5]; the head model died.
    const d = await runFailover(usageLimitInput(io, {
      role: 'final-reviewer-a',
      assignment: asg('codex', 'final-reviewer-a', 'gpt-5.6-sol', 'xhigh'),
      transcript: MODEL_UNAVAIL,
      exitCode: 1,
    }));
    assert.equal(d.class, 'model-unavailable');
    assert.equal(d.action, 'relaunch');
    assert.equal(d.assignment.platform, 'codex', 'no platform-wide avoidance — the same platform is retried');
    assert.equal(d.assignment.model, 'gpt-5.5', 'the next chain entry (a different model) is selected');
    assert.ok(
      d.avoidEntries.some((/** @type {any} */ e) => e.platform === 'codex' && /gpt-5\.6-sol/.test(e.model)),
      'the dead {platform, model} is recorded in avoidEntries',
    );
  });

  it('a model-level failure performs NO seal and NO receive (bundle untouched)', async () => {
    const { runFailover } = M();
    const io = makeRepoIo();
    await runFailover(usageLimitInput(io, {
      role: 'final-reviewer-a',
      assignment: asg('codex', 'final-reviewer-a', 'gpt-5.6-sol', 'xhigh'),
      transcript: MODEL_UNAVAIL,
      exitCode: 1,
    }));
    const live = loadBundle('/repo', io).bundle;
    assert.equal(live.generation, 1, 'no receive/generation bump for a model-level failure');
    assert.equal(live.handoff.status, 'open', 'the bundle is not sealed');
    assert.equal(historyFreezes(io).length, 0, 'no freeze written');
  });
});

// ===========================================================================
describe('runFailover — usage-limit: the exact transaction', () => {
  it('(a,b) a *.finalize.json freeze is sealed, reasonClass usage-limit, and CARRIES the checkpointed loop position', async () => {
    const { runFailover } = M();
    const io = makeRepoIo({ status: 'open' });
    // The sentinel is not in the seed — it can only appear via a checkpoint that
    // landed in the bundle BEFORE the seal (finding 1 — no longer keys on 'run1').
    assert.ok(!io.files()['/repo/.handoff/bundle.json'].includes(POSITION_SENTINEL), 'precondition: sentinel absent from the seed');

    await runFailover(usageLimitInput(io));

    const fin = historyFreezes(io).find((f) => /\.finalize\.json$/.test(f.name));
    assert.ok(fin, 'the transaction froze a .finalize.json (the seal)');
    assert.equal(fin.data.handoff.status, 'sealed', 'the finalize freeze is sealed');
    assert.equal(fin.data.handoff.reasonClass, 'usage-limit', 'sealed with reasonClass usage-limit');
    assert.match(JSON.stringify(fin.data), new RegExp(POSITION_SENTINEL), 'the sealed freeze carries the loop position checkpointed before the seal');
  });

  it('(c) receive prepare+commit adopt the target: gen incremented, owned by the target, supervisor session hint', async () => {
    const { runFailover } = M();
    const io = makeRepoIo({ status: 'open' });
    const d = await runFailover(usageLimitInput(io));
    const live = loadBundle('/repo', io).bundle;
    assert.equal(live.generation, 2, 'the receive opened a fresh generation');
    assert.notEqual(live.origin.platform, 'codex', 'ownership never adopts back onto the dead origin');
    assert.equal(live.origin.platform, d.assignment.platform, 'the new owner is the relaunch target');
    assert.equal(live.origin.sessionHint, 'loop-run1', 'the fresh generation is owned by the supervisor session hint');
  });

  it('(finding 2) dead-platform avoidance is provable: a codex-first chain relaunches its NON-codex second entry', async () => {
    const { runFailover } = M();
    const io = makeRepoIo({ status: 'open' });
    // plan-reviewer chain STARTS with codex/gpt-5.6-sol; forgetting to avoid would
    // reselect codex. The relaunch must pick the second entry, claude-code.
    const d = await runFailover(usageLimitInput(io, {
      role: 'plan-reviewer',
      assignment: asg('codex', 'plan-reviewer', 'gpt-5.6-sol', 'xhigh'),
    }));
    assert.equal(d.action, 'relaunch');
    assert.equal(d.assignment.platform, 'claude-code', 'the dead codex origin is avoided — the second chain entry is chosen');
    assert.equal(d.assignment.model, 'claude-fable-5');
  });

  it('(finding 4) the class comes from the loaded signature TABLE: a fixture-only substring drives usage-limit', async () => {
    const { runFailover } = M();
    // A made-up substring NOT in the shipped table. Only an impl that LOADS and
    // consults the (seeded) signature table classifies it usage-limit; a hardcoded
    // shipped-string impl would classify other-error and skip the transaction.
    const io = makeRepoIo({
      status: 'open',
      extraSignatures: [{ id: 'codex/fixture-only', platform: 'codex', class: 'usage-limit', confidence: 'high', matcher: { kind: 'substring', value: 'FIXTURE_ONLY_LIMIT_SENTINEL_ZZ' } }],
    });
    const d = await runFailover(usageLimitInput(io, { transcript: 'child died: FIXTURE_ONLY_LIMIT_SENTINEL_ZZ', exitCode: 1 }));
    assert.equal(d.class, 'usage-limit', 'the fixture-only signature was consulted from the table');
    assert.equal(d.action, 'relaunch');
    assert.equal(loadBundle('/repo', io).bundle.generation, 2, 'the usage-limit transaction ran end to end');
  });

  it('(a) alive-supervisor open path: checkpoint -> finalize -> SEALED receive, NO degraded flag', async () => {
    const { runFailover } = M();
    const io = makeRepoIo({ status: 'open' });
    await runFailover(usageLimitInput(io)); // default: the supervisor can seal
    const freezes = historyFreezes(io);
    const fin = freezes.find((f) => /\.finalize\.json$/.test(f.name));
    assert.ok(fin && fin.data.handoff.status === 'sealed', 'the alive path seals via a .finalize.json freeze');
    const received = freezes.find((f) => f.data.handoff && f.data.handoff.status === 'received');
    assert.ok(received, 'commit reaches a received seal');
    assert.doesNotMatch(JSON.stringify(received.data.handoff.receive_log ?? []), /degraded/i, 'a sealed->received commit is NOT flagged degraded');
  });

  it('(b) degraded-open path: finalize skipped (degradedOpen) -> NO .finalize.json, a DEGRADED receive seal', async () => {
    const { runFailover } = M();
    const io = makeRepoIo({ status: 'open' });
    // The supervisor could not cleanly seal (prior limit death left the bundle
    // unsealed); runFailover skips finalize and takes receive's degraded-open path.
    const d = await runFailover(usageLimitInput(io, { degradedOpen: true }));
    const freezes = historyFreezes(io);
    assert.ok(!freezes.some((f) => /\.finalize\.json$/.test(f.name)), 'no finalize freeze — the seal was skipped');
    const received = freezes.find((f) => f.data.handoff && f.data.handoff.status === 'received');
    assert.ok(received, 'an unsealed limit-death still reaches a received seal (degraded-open path)');
    assert.match(JSON.stringify(received.data.handoff.receive_log ?? []), /degraded[-_ ]?seal|degradedSeal/i, 'the open->received commit is flagged degraded');
    assert.equal(loadBundle('/repo', io).bundle.generation, 2, 'the degraded receive still opened a fresh generation');
    assert.equal(d.action, 'relaunch');
  });

  it('(d) NO-WRITE WINDOW: the whole usage-limit transaction writes NOTHING under .handoff/loop', async () => {
    const { runFailover } = M();
    const io = makeRepoIo({ status: 'open' });
    const loopWrites = spyLoopWrites(io);
    await runFailover(usageLimitInput(io));
    // The transaction touches only the bundle tree; loop-state is the supervisor's
    // to write AFTER, from the returned decision. This subsumes the prepare->commit
    // window (no loop write anywhere in the failover).
    assert.deepEqual(loopWrites, [], `the failover transaction must not write under .handoff/loop; wrote: ${JSON.stringify(loopWrites)}`);
  });

  it('(f) the relaunch decision carries the resolver assignment (dead origin avoided) and a resume prompt', async () => {
    const { runFailover } = M();
    const io = makeRepoIo({ status: 'open' });
    const d = await runFailover(usageLimitInput(io));
    assert.equal(d.action, 'relaunch');
    assert.equal(d.class, 'usage-limit');
    assert.notEqual(d.assignment.platform, 'codex', 'the relaunch assignment never lands on the dead origin');
    assert.ok(typeof d.prompt === 'string' && d.prompt.includes(GOAL), 'a resume prompt is returned, carrying the goal');
  });

  it('is deterministic from injected io (identical ios -> identical decision)', async () => {
    const { runFailover } = M();
    const a = await runFailover(usageLimitInput(makeRepoIo({ status: 'open' })));
    const b = await runFailover(usageLimitInput(makeRepoIo({ status: 'open' })));
    assert.deepEqual(a.assignment, b.assignment, 'the relaunch target is deterministic');
    assert.equal(a.action, b.action);
  });
});

// ===========================================================================
describe('runFailover — usage-limit: git drift between prepare and commit (e), via io.execFile', () => {
  // Drift tests seed an ALREADY-SEALED bundle and pass no new loopState, so the
  // only git consumers are receive's prepare + commit — each HEAD read maps 1:1
  // onto a prepare/commit call, with no leading finalize/checkpoint git.
  const driftInput = (io) => usageLimitInput(io, { loopState: undefined });

  it('git moves ONCE between prepare and its commit -> first commit stale -> ONE re-prepare+commit succeeds', async () => {
    const { runFailover } = M();
    // calls: 1=prepare(A) 2=commit(B, differs -> stale) 3=re-prepare(stable) 4=re-commit(stable, matches)
    const git = gitExec((n) => (n === 1 ? 'HEAD-A' : n === 2 ? 'HEAD-B' : 'HEAD-STABLE'));
    const io = makeRepoIo({ status: 'sealed', execFile: git });
    const d = await runFailover(driftInput(io));
    assert.equal(d.action, 'relaunch', 'the single automatic retry recovers from the one-time drift');
    assert.equal(loadBundle('/repo', io).bundle.generation, 2, 'the retried commit landed');
  });

  it('git keeps moving every window -> SECOND consecutive stale -> {action:park}, EXACTLY two prepare/commit windows', async () => {
    const { runFailover } = M();
    // Every call a new HEAD: commit always differs from its own prepare -> stale.
    const git = gitExec((n) => `HEAD-${n}`);
    const io = makeRepoIo({ status: 'sealed', execFile: git });
    const d = await runFailover(driftInput(io));
    assert.equal(d.action, 'park', 'two consecutive stale commits park instead of looping');
    assert.match(String(d.reason), /stale|drift|re-?prepare/i, 'the park reason names the drift');
    assert.equal(loadBundle('/repo', io).bundle.generation, 1, 'no generation opened when the failover parked');
    // Retry cap is EXACTLY one: two prepare+commit windows = 4 HEAD reads; a
    // bounded-3+ loop would read 6+ (finding 3).
    assert.equal(git.headCalls(), 4, 'exactly two prepare->commit windows were attempted (one retry, then park)');
  });
});

// ===========================================================================
describe('runFailover — usage-limit: total exhaustion (g)', () => {
  it('all platforms/entries avoided -> {action:park} with a resume-at hint from the classifier', async () => {
    const { runFailover } = M();
    const io = makeRepoIo({ status: 'open' });
    const d = await runFailover(usageLimitInput(io, {
      transcript: CODEX_LIMIT_HINT, // carries a "try again at 6:00 PM" reset hint
      avoid: ['claude-code', 'codex', 'cursor'], // nothing left to relaunch onto
    }));
    assert.equal(d.action, 'park', 'with no eligible platform the loop parks rather than dying');
    assert.match(String(d.resumeAt), /6:00 PM/, 'the park carries the classifier-extracted resume-at hint');
  });
});
