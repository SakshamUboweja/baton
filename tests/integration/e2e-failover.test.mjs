import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile as realExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as nodeFs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdInit } from '../../core/src/commands/init.mjs';
import { cmdCheckpoint } from '../../core/src/commands/checkpoint.mjs';
import { cmdFinalize } from '../../core/src/commands/finalize.mjs';
import { cmdReceive } from '../../core/src/commands/receive.mjs';
import { loadBundle, bundlePaths } from '../../core/src/bundle/store.mjs';
import { withLock, guardedWrite, recoverLock } from '../../core/src/bundle/lock.mjs';

// ---------------------------------------------------------------------------
// Real-filesystem end-to-end failover proof (plan §Acceptance constraint 1: "a
// session's bundle survives a kill-mid-write, finalizes with a usage-limit
// reason, and produces a correct remapped resume prompt — contract-tested in all
// six directions"; §Concurrency "six-direction contract tests cover sealed +
// unsealed variants"; constraint 6: dual writers, provably-dead takeover,
// competing receivers, prepare-without-commit, chained failover; docs/design/
// core.md §integration test list).
//
// TARGET MODULE: core/src/commands/init.mjs (sole unimplemented dependency and
// this file's declared target — its absence is the only reason this file is
// RED). init is the first step of the real failover flow; every other module the
// e2e drives (checkpoint, finalize, receive, store, lock, txn, git/snapshot) is
// already implemented, so once init lands the whole file runs green.
//
// This suite runs over the REAL fs (mkdtemp) with a REAL git repo (where the
// flow needs one) and a purpose-built real-fs `io` (node:fs + a promisified
// execFile), NOT the memfs fake — the point is to exercise atomic writes,
// journal replay, locks, and git re-derivation against a real filesystem.
// Unit-level equivalents of some concurrency cases exist in tests/unit/
// lock.test.mjs and tests/unit/receive-txn.test.mjs over memfs; the versions
// here re-exercise those CONTRACTS through the real fs and the real command
// layer, asserting outcomes (exit codes, on-disk tree bytes), not memfs
// internals.
//
// PINS (documented so the contract is explicit where the plan left room):
//   E1. "Golden-pinned resume prompt" is realized as PINNED CONTENT (the goal,
//       the claims-not-instructions posture line, the HANDOFF.md pointer, the
//       origin/reason, and the REMAPPED role platforms), plus the <=2500 cap.
//       The byte-exact prompt FORMAT is already golden-pinned by
//       tests/unit/receive-prompt.test.mjs; pinning bytes again here is brittle
//       against a real git sha / timestamps, so this file pins the failover
//       FACTS instead (correct remap, dead origin avoided).
//   E2. FAILOVER INVARIANT (universal, every direction): when the switch reason
//       classifies as usage-limit for the origin, NO role remaps back onto the
//       dead origin platform. "At least one role resolves to the target" is
//       asserted only where the committed config guarantees it (the resolver
//       uses nativeOnly:false at receive, so a target with no earlier-eligible
//       chain entry can legitimately yield zero target rows).
//   E3. The controlled baton.config.json (the methodology 7-role matrix) is
//       written into the repo AFTER init so the remap is deterministic and
//       decoupled from init's template content; init-scaffold correctness is
//       asserted separately (a valid config + a covering .gitignore land).
//   E4. Per-platform usage-limit reason strings come from core/data/
//       signatures.v1.json so classifyReason yields usage-limit for the origin
//       (claude-code "session limit", codex "usage limit", cursor regex).
//   E5. SIX-DIRECTION MATRIX (verifier fold F1): each of the 6 directions runs
//       over BOTH a sealed and an open (unsealed limit-death) bundle, through
//       prepare AND commit, asserting: no dead-origin remap; the open variant
//       warns "unsealed" at prepare and its archived freeze carries the
//       degraded-seal flag (plan: "commit writes a receive-generated degraded
//       seal recording intake origin/reason, flagged `degraded-seal`" — matched
//       tolerantly as /degraded[-_ ]?seal|degradedSeal/); exactly one 'receive'
//       freeze whose handoff.status is 'received'; the live bundle opens
//       generation 2 owned by the target.
//   E6. CONCURRENCY STAGING (verifier fold F2): the `recover` CLI command is NOT
//       a wave-D target (importing core/src/commands/recover.mjs would add a
//       second missing module and break the one-red-cause rule), so forced
//       recovery is exercised through the implemented library surface
//       (bundle/lock.mjs recoverLock) over the REAL fs — same contract, real-fs
//       altitude. pause-after-final-fence-check needs injected interleaving that
//       no black-box spawn can produce: it is staged by holding the REAL lock
//       via withLock and rewriting owner.json on disk mid-hold (the competing
//       takeover), then asserting guardedWrite fast-aborts with FencingError and
//       the guarded write never lands on disk.
// ---------------------------------------------------------------------------

const NOW = '2026-07-11T00:00:00.000Z';
const GOAL = 'End-to-end failover proof';
const CC_LIMIT = "You've hit your session limit · resets 3pm"; // claude-code usage-limit signature
const CODEX_LIMIT = "You've hit your usage limit"; //            codex usage-limit signature
const CURSOR_LIMIT = 'usage limit exceeded'; //                  cursor usage-limit heuristic (regex)
const LIMIT_FOR = { 'claude-code': CC_LIMIT, codex: CODEX_LIMIT, cursor: CURSOR_LIMIT };
const CLAIMS_SUB = 'unverified claims to check against the working tree';
const POINTER = 'Read .handoff/HANDOFF.md for full context before acting.';

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

const pexec = promisify(realExecFile);
const tmpDirs = [];

/** A real-fs io honoring the injected-io contract (docs/design/core.md). */
function makeRealIo(cwd, { stdin = '', now = NOW, processAlive } = {}) {
  const out = [];
  const err = [];
  let tokenN = 0;
  return {
    cwd,
    env: { ...process.env },
    stdin,
    stdout: { write: (s) => (out.push(String(s)), true) },
    stderr: { write: (s) => (err.push(String(s)), true) },
    fs: nodeFs,
    execFile: (cmd, args = [], opts = {}) => pexec(cmd, args, { ...opts, encoding: 'utf8' }),
    now: () => now,
    host: 'e2e-host',
    pid: 4242,
    startTime: 111000,
    processAlive: processAlive || ((pid) => pid === 4242),
    // Small retry budget (gate-2 fix 12): the live-lock refusal fixture below
    // pins the drop-after-bounded-wait behavior without the 3 s production wait.
    lockRetry: { attempts: 2, delayMs: 5 },
    newFencingToken: () => `e2e-tok-${(tokenN += 1)}`,
    stdoutText: () => out.join(''),
    stderrText: () => err.join(''),
  };
}

function mkTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** A fresh real git repo with one commit and no AI attribution anywhere. */
function initRepo(cwd) {
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'e2e@example.test']);
  git(cwd, ['config', 'user.name', 'baton e2e']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  nodeFs.writeFileSync(join(cwd, 'README.md'), '# demo\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-q', '-m', 'initial']);
}

const evt = (obj, dedupeKey, { sessionHint = 'A-sess', unstable = false } = {}) =>
  JSON.stringify({ schema: 'baton/event@1', dedupeKey, sessionHint, unstable, ...obj });

/** 25 pre-normalized baton/event@1 checkpoints with unique dedupe keys. */
function buildEvents() {
  const e = [];
  e.push(evt({ type: 'task.update', payload: { goal: GOAL, constraints: ['Deterministic output'], acceptance: ['survives kill-mid-write'] } }, 'e2e-goal'));
  e.push(evt({ type: 'plan.set', payload: { steps: [
    { id: 's1', title: 'Init scaffold', status: 'pending', note: null },
    { id: 's2', title: 'Run the checkpoint loop', status: 'pending', note: null },
    { id: 's3', title: 'Finalize and receive', status: 'pending', note: null },
    { id: 's4', title: 'Prove chained failover', status: 'pending', note: null },
  ] } }, 'e2e-plan'));
  e.push(evt({ type: 'plan.step', payload: { id: 's1', status: 'done' } }, 'e2e-s1'));
  for (let i = e.length; i < 25; i += 1) {
    e.push(i % 2 === 0 ? evt({ type: 'decision', payload: { summary: `decision ${i}` } }, `e2e-d${i}`) : evt({ type: 'note', payload: { text: `note ${i}` } }, `e2e-n${i}`));
  }
  return e;
}

async function runCheckpoints(cwd, platform) {
  for (const [i, stdin] of buildEvents().entries()) {
    const io = makeRealIo(cwd, { stdin });
    const code = await cmdCheckpoint(['--platform', platform], io);
    assert.equal(code, 0, `checkpoint ${i} must be hook-safe (exit 0); stderr: ${io.stderrText()}`);
  }
}

/** init a real repo, scaffold, then pin the controlled config (E3). */
async function setupProject(prefix) {
  const cwd = mkTmp(prefix);
  initRepo(cwd);
  const initIo = makeRealIo(cwd);
  const initCode = await cmdInit([], initIo);
  assert.equal(initCode, 0, `init must scaffold cleanly; stderr: ${initIo.stderrText()}`);
  // init-scaffold correctness (E3): a valid config + a covering .gitignore.
  assert.equal(JSON.parse(nodeFs.readFileSync(join(cwd, 'baton.config.json'), 'utf8')).schema, 'baton/config@1');
  assert.match(nodeFs.readFileSync(join(cwd, '.gitignore'), 'utf8'), /(^|\n)\.handoff\/?\n/);
  // Pin the controlled matrix for deterministic remap.
  nodeFs.writeFileSync(join(cwd, 'baton.config.json'), JSON.stringify(CONFIG, null, 2));
  return cwd;
}

/** Snapshot every file under <cwd>/.handoff for byte-level no-mutation checks. */
function snapshotTree(cwd) {
  const out = {};
  const walk = (dir) => {
    if (!nodeFs.existsSync(dir)) return;
    for (const name of nodeFs.readdirSync(dir)) {
      const p = join(dir, name);
      if (nodeFs.statSync(p).isDirectory()) walk(p);
      else out[p] = nodeFs.readFileSync(p, 'utf8');
    }
  };
  walk(join(cwd, '.handoff'));
  return out;
}

/**
 * A directly-written bundle + config repo (no git needed) for contract tests.
 * status 'sealed' models a finalized handoff; 'open' models the primary failure
 * case — limit death before finalize (plan: open -> received, degraded seal).
 */
function writeBundleRepo(prefix, originPlatform, status = 'sealed', overrides = {}) {
  const cwd = mkTmp(prefix);
  const p = bundlePaths(cwd);
  nodeFs.mkdirSync(p.dir, { recursive: true });
  const bundle = {
    schema: 'baton/bundle@1',
    bundleId: 'b_e2edirect00000',
    generation: 1,
    createdAt: NOW,
    updatedAt: NOW,
    origin: { platform: originPlatform, model: 'm', sessionHint: 'orig-sess', unstable: false },
    task: { goal: GOAL, constraints: [], acceptance: [] },
    plan: { steps: [{ id: 's1', title: 'Continue the task', status: 'active', note: null }] },
    decisions: [],
    files: { touched: [] },
    roles: { assignments: {} },
    git: null,
    handoff:
      status === 'sealed'
        ? { status: 'sealed', reason: 'seal', reasonClass: 'usage-limit', toPlatformHint: null, finalizedAt: NOW, receive_log: [] }
        : { status: 'open', reason: null, reasonClass: null, toPlatformHint: null, finalizedAt: null, receive_log: [] },
    journalSeq: 0,
    compaction: { droppedDecisions: 0, note: null },
    dedupeRing: [],
    ...overrides,
  };
  nodeFs.writeFileSync(p.snapshot, JSON.stringify(bundle, null, 2) + '\n');
  nodeFs.writeFileSync(join(cwd, 'baton.config.json'), JSON.stringify(CONFIG, null, 2));
  return cwd;
}

const platformsOf = (assignments) => Object.values(assignments).map((a) => a.platform);

const receiveFreezes = (cwd) => {
  const dir = bundlePaths(cwd).historyDir;
  if (!nodeFs.existsSync(dir)) return [];
  return nodeFs.readdirSync(dir).filter((n) => /\.receive\.json$/.test(n));
};

after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// ===========================================================================
describe('e2e failover — init -> 25 checkpoints -> kill-mid-write -> finalize -> receive', () => {
  it('survives a kill-mid-write, seals with a usage-limit reason, and prints a correct remapped prompt', async () => {
    const cwd = await setupProject('baton-e2e-main-');

    // 25 mechanical checkpoints on claude-code.
    await runCheckpoints(cwd, 'claude-code');
    const built = loadBundle(cwd, makeRealIo(cwd)).bundle;
    assert.equal(built.task.goal, GOAL, 'the task.update checkpoint set the goal');
    assert.ok(built.plan.steps.length >= 4, 'the plan.set checkpoint recorded the steps');

    // Kill-mid-write: an orphaned atomic-write tmp + a torn live snapshot, with an
    // intact .bak. The bundle must recover from .bak + full journal replay.
    const p = bundlePaths(cwd);
    assert.ok(nodeFs.existsSync(p.bak), 'the checkpoint rewrites produced a .bak to recover from');
    nodeFs.writeFileSync(`${p.snapshot}.tmp.999-1`, '{"schema":"baton/bundle@1","half'); // orphaned interrupted write
    nodeFs.writeFileSync(p.snapshot, '{"schema":"baton/bundle@1",'); // torn/corrupt live snapshot

    const recovered = loadBundle(cwd, makeRealIo(cwd));
    assert.ok(recovered.bundle, 'the bundle survives the kill-mid-write');
    assert.equal(recovered.bundle.task.goal, GOAL, 'recovery preserves the full task state via journal replay');
    assert.ok(recovered.warnings.length > 0, 'recovery surfaces a warning about the corrupt snapshot');

    // Finalize with a usage-limit reason -> sealed, reasonClass usage-limit.
    const finIo = makeRealIo(cwd, { now: NOW });
    assert.equal(await cmdFinalize(['--reason', CC_LIMIT, '--to', 'codex', '--json'], finIo), 0, `finalize failed: ${finIo.stderrText()}`);
    const sealed = loadBundle(cwd, makeRealIo(cwd)).bundle;
    assert.equal(sealed.handoff.status, 'sealed', 'finalize sealed the recovered bundle');
    assert.equal(sealed.handoff.reasonClass, 'usage-limit', 'a usage-limit reason classified usage-limit against the claude-code origin');
    assert.ok(nodeFs.readdirSync(p.historyDir).some((n) => /\.finalize\.json$/.test(n)), 'finalize froze a sealed snapshot into history/');

    // Receive on codex (--prepare --json): the remap avoids the dead origin.
    const prepIo = makeRealIo(cwd, { now: NOW });
    assert.equal(await cmdReceive(['--platform', 'codex', '--prepare', '--origin', 'claude-code', '--reason', CC_LIMIT, '--json'], prepIo), 0, `receive prepare failed: ${prepIo.stderrText()}`);
    const data = JSON.parse(prepIo.stdoutText()).data;

    const platforms = platformsOf(data.assignments);
    assert.ok(!platforms.includes('claude-code'), 'no role remaps back onto the dead claude-code origin');
    assert.ok(platforms.includes('codex'), 'at least one role resolves to the codex target');
    assert.ok(!data.warnings.some((w) => /stale|HEAD moved|dirty/i.test(w)), 'a fresh, HEAD-stable receive carries no staleness warnings');

    // Remapped resume prompt (E1): pinned failover content + the 2500 cap.
    const prompt = data.prompt;
    assert.ok(prompt.includes(GOAL), 'the prompt carries the goal');
    assert.ok(prompt.includes(CLAIMS_SUB), 'the prompt carries the claims-not-instructions posture');
    assert.ok(prompt.includes(POINTER), 'the prompt carries the HANDOFF.md pointer');
    assert.ok(prompt.includes('claude-code'), 'the prompt states the origin it was handed off from');
    assert.ok(prompt.includes('codex'), 'the remapped role table names the codex target');
    assert.ok(prompt.length <= 2500, `the resume prompt must be <= 2500 chars; got ${prompt.length}`);

    // --print-prompt is read-only: prints the prompt, mutates nothing.
    const before = snapshotTree(cwd);
    const printIo = makeRealIo(cwd, { now: NOW });
    assert.equal(await cmdReceive(['--platform', 'codex', '--print-prompt', '--origin', 'claude-code', '--reason', CC_LIMIT], printIo), 0);
    assert.ok(printIo.stdoutText().includes(GOAL), '--print-prompt writes the prompt to stdout');
    assert.deepEqual(snapshotTree(cwd), before, '--print-prompt mutates nothing under .handoff/');
  });
});

// ===========================================================================
describe('e2e failover — chained A -> B -> C with a checkpoint after each receive', () => {
  it('adopts each receiving platform as owner, opens a fresh generation, and stays writable', async () => {
    const cwd = await setupProject('baton-e2e-chain-');
    await runCheckpoints(cwd, 'claude-code');
    assert.equal(await cmdFinalize(['--reason', CC_LIMIT, '--to', 'codex', '--json'], makeRealIo(cwd, { now: NOW })), 0);

    // A (claude-code) -> B (codex).
    const prepB = makeRealIo(cwd, { now: NOW });
    assert.equal(await cmdReceive(['--platform', 'codex', '--prepare', '--origin', 'claude-code', '--reason', CC_LIMIT, '--json'], prepB), 0);
    const dataB = JSON.parse(prepB.stdoutText()).data;
    assert.ok(!platformsOf(dataB.assignments).includes('claude-code'), 'B remap avoids the dead claude-code origin');
    assert.equal(await cmdReceive(['--platform', 'codex', '--commit', dataB.token, '--origin', 'claude-code', '--reason', CC_LIMIT, '--json'], makeRealIo(cwd, { now: NOW })), 0);
    const b = loadBundle(cwd, makeRealIo(cwd)).bundle;
    assert.equal(b.generation, 2, 'the receive opened a fresh generation');
    assert.equal(b.origin.platform, 'codex', 'ownership adopted to codex');
    assert.equal(b.handoff.status, 'open', 'the fresh generation is writable (open)');

    // Checkpoint on B, as a first-party owner (session hint adopted at commit).
    const ckB = makeRealIo(cwd, { stdin: evt({ type: 'decision', payload: { summary: 'first-party-on-B' } }, 'chain-B', { sessionHint: b.origin.sessionHint }) });
    assert.equal(await cmdCheckpoint(['--platform', 'codex'], ckB), 0);
    assert.ok(loadBundle(cwd, makeRealIo(cwd)).bundle.decisions.some((d) => d.summary === 'first-party-on-B'), 'the fresh generation accepts a first-party checkpoint');

    // B seals (usage-limit again) and hands to C (cursor).
    assert.equal(await cmdFinalize(['--reason', CODEX_LIMIT, '--to', 'cursor', '--json'], makeRealIo(cwd, { now: NOW })), 0);
    const prepC = makeRealIo(cwd, { now: NOW });
    assert.equal(await cmdReceive(['--platform', 'cursor', '--prepare', '--origin', 'codex', '--reason', CODEX_LIMIT, '--json'], prepC), 0);
    const dataC = JSON.parse(prepC.stdoutText()).data;
    assert.ok(!platformsOf(dataC.assignments).includes('codex'), 'C remap avoids the now-dead codex origin');
    assert.equal(await cmdReceive(['--platform', 'cursor', '--commit', dataC.token, '--origin', 'codex', '--reason', CODEX_LIMIT, '--json'], makeRealIo(cwd, { now: NOW })), 0);
    const c = loadBundle(cwd, makeRealIo(cwd)).bundle;
    assert.equal(c.generation, 3, 'a second receive opened a third generation — chained failover does not dead-end');
    assert.equal(c.origin.platform, 'cursor', 'ownership adopted to cursor');
    assert.equal(c.handoff.status, 'open', 'the third generation is writable');

    const ckC = makeRealIo(cwd, { stdin: evt({ type: 'decision', payload: { summary: 'first-party-on-C' } }, 'chain-C', { sessionHint: c.origin.sessionHint }) });
    assert.equal(await cmdCheckpoint(['--platform', 'cursor'], ckC), 0);
    assert.ok(loadBundle(cwd, makeRealIo(cwd)).bundle.decisions.some((d) => d.summary === 'first-party-on-C'), 'the third generation accepts a first-party checkpoint');
  });
});

// ===========================================================================
// (E5 / fold F1) Six directions x {sealed, open}: prepare AND commit, with the
// degraded-seal contract for the open (limit-death-before-finalize) variant.
describe('e2e failover — six-direction matrix, sealed AND open variants (prepare + commit)', () => {
  const DIRECTIONS = [
    ['claude-code', 'codex'],
    ['codex', 'claude-code'],
    ['claude-code', 'cursor'],
    ['cursor', 'claude-code'],
    ['codex', 'cursor'],
    ['cursor', 'codex'],
  ];

  for (const [origin, target] of DIRECTIONS) {
    for (const status of ['sealed', 'open']) {
      it(`${origin} -> ${target} (${status}): no dead-origin remap; commit adopts ${target}, opens gen 2, archives a received${status === 'open' ? ' degraded' : ''} seal`, async () => {
        const reason = LIMIT_FOR[origin];
        const cwd = writeBundleRepo('baton-e2e-dir-', origin, status);

        // Prepare: remap correctness + the unsealed warning for the open variant.
        const prep = makeRealIo(cwd, { now: NOW });
        assert.equal(await cmdReceive(['--platform', target, '--prepare', '--origin', origin, '--reason', reason, '--json'], prep), 0, `prepare ${origin}->${target} (${status}) failed: ${prep.stderrText()}`);
        const data = JSON.parse(prep.stdoutText()).data;

        const platforms = platformsOf(data.assignments);
        assert.ok(!platforms.includes(origin), `(E2) no role may remap back onto the dead origin ${origin}`);
        assert.ok(platforms.some((pf) => pf !== null), 'at least one role resolves to a usable platform');
        for (const [role, a] of Object.entries(data.assignments)) {
          assert.ok(['native', 'delegated', 'unavailable'].includes(a.mode), `${role}.mode invalid: ${a.mode}`);
        }
        if (status === 'open') {
          assert.ok(
            data.warnings.some((w) => /unsealed|never finalized|degraded/i.test(w)),
            `an open bundle warns it was never finalized; got ${JSON.stringify(data.warnings)}`,
          );
        }

        // Commit: the atomic transition (sealed->received / open->received).
        const commitIo = makeRealIo(cwd, { now: NOW });
        const code = await cmdReceive(['--platform', target, '--commit', data.token, '--origin', origin, '--reason', reason, '--json'], commitIo);
        assert.equal(code, 0, `commit ${origin}->${target} (${status}) failed: ${commitIo.stderrText()} ${commitIo.stdoutText()}`);

        // Live bundle: fresh writable generation owned by the target.
        const live = loadBundle(cwd, makeRealIo(cwd)).bundle;
        assert.equal(live.generation, 2, 'commit opened a fresh generation');
        assert.equal(live.origin.platform, target, 'ownership adopted to the receiving platform');
        assert.equal(live.handoff.status, 'open', 'the new live generation is writable (open)');

        // Archive: exactly one 'receive' freeze, and it is the RECEIVED seal.
        const freezes = receiveFreezes(cwd);
        assert.equal(freezes.length, 1, 'exactly one receive rotation freeze exists');
        const freeze = JSON.parse(nodeFs.readFileSync(join(bundlePaths(cwd).historyDir, freezes[0]), 'utf8'));
        assert.equal(freeze.handoff.status, 'received', 'the archived freeze records the received transition');
        const entry = freeze.handoff.receive_log[freeze.handoff.receive_log.length - 1];
        assert.ok(entry, 'the received seal logs the receive');
        assert.equal(entry.origin, origin, 'the receive log records the intake origin');
        assert.equal(entry.reason, reason, 'the receive log records the intake reason');

        if (status === 'open') {
          // The primary failure case: a receive-generated DEGRADED seal.
          assert.match(JSON.stringify(entry), /degraded[-_ ]?seal|degradedSeal/i, 'an open->received commit flags the degraded seal');
          assert.equal(freeze.handoff.reason, reason, 'the degraded seal records the intake reason as the seal reason');
        } else {
          assert.doesNotMatch(JSON.stringify(entry), /degraded/i, 'a sealed->received commit is NOT flagged degraded');
        }
      });
    }
  }
});

// ===========================================================================
describe('e2e failover — concurrency', () => {
  it('dual writers: a live foreign lock refuses a checkpoint (exit 0, hook-safe) and mutates nothing', async () => {
    const cwd = await setupProject('baton-e2e-dual-');
    await runCheckpoints(cwd, 'claude-code');

    const p = bundlePaths(cwd);
    nodeFs.mkdirSync(p.lockDir, { recursive: true });
    nodeFs.writeFileSync(`${p.lockDir}/owner.json`, JSON.stringify({ host: 'e2e-host', pid: 999999, startTime: 7, fencingToken: 'LIVE', acquiredAt: NOW, heartbeatAt: NOW }));

    const before = snapshotTree(cwd);
    const io = makeRealIo(cwd, { stdin: evt({ type: 'decision', payload: { summary: 'blocked-writer' } }, 'dual-1'), processAlive: (pid) => pid === 999999 || pid === 4242 });
    const code = await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.equal(code, 0, 'a lock-blocked checkpoint still soft-fails to exit 0 (hook safety)');
    assert.match(io.stderrText(), /lock|held|live|terminate|process/i, 'a warning explains the live lock');
    assert.deepEqual(snapshotTree(cwd), before, 'a lock-refused checkpoint mutates nothing (no journal append)');
  });

  it('provably-dead takeover: a checkpoint reclaims a dead same-host lock and applies', async () => {
    const cwd = await setupProject('baton-e2e-dead-');
    await runCheckpoints(cwd, 'claude-code');

    const p = bundlePaths(cwd);
    nodeFs.mkdirSync(p.lockDir, { recursive: true });
    nodeFs.writeFileSync(`${p.lockDir}/owner.json`, JSON.stringify({ host: 'e2e-host', pid: 999999, startTime: 7, fencingToken: 'STALE', acquiredAt: NOW, heartbeatAt: NOW }));

    // Default processAlive: only pid 4242 is alive, so 999999 is provably dead.
    const io = makeRealIo(cwd, { stdin: evt({ type: 'decision', payload: { summary: 'took-over-dead-lock' } }, 'dead-1') });
    const code = await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.equal(code, 0);
    assert.ok(loadBundle(cwd, makeRealIo(cwd)).bundle.decisions.some((d) => d.summary === 'took-over-dead-lock'), 'the checkpoint took over the dead lock and applied');
    assert.equal(nodeFs.existsSync(p.lockDir), false, 'the operation-scoped lock is released after the takeover');
  });

  it('(F2) torn owner metadata: a checkpoint soft-refuses (exit 0, tree untouched) and recoverLock --force still refuses on the real fs', async () => {
    const cwd = writeBundleRepo('baton-e2e-torn-', 'claude-code', 'open');
    const p = bundlePaths(cwd);
    nodeFs.mkdirSync(p.lockDir, { recursive: true }); // lock dir present, owner.json MISSING = torn/unknown owner
    const before = snapshotTree(cwd);

    const ck = makeRealIo(cwd, { stdin: evt({ type: 'decision', payload: { summary: 'under-torn-lock' } }, 'torn-1', { sessionHint: 'orig-sess' }) });
    const code = await cmdCheckpoint(['--platform', 'claude-code'], ck);
    assert.equal(code, 0, 'a torn-lock refusal is still hook-safe (exit 0)');
    assert.match(ck.stderrText(), /metadata|owner|torn|unsupported|manual|recover|lock/i, 'the warning explains the torn lock');
    assert.deepEqual(snapshotTree(cwd), before, 'a torn-lock refusal mutates nothing anywhere under .handoff/');

    const beforeRecover = snapshotTree(cwd);
    const r = recoverLock(cwd, makeRealIo(cwd), { force: true });
    assert.equal(r.recovered, false, 'torn metadata is unsupported for automatic recovery even with force (real fs)');
    assert.ok(r.refusedReason, 'the refusal explains itself');
    assert.ok(nodeFs.existsSync(p.lockDir), 'the torn lock dir is preserved on disk');
    assert.deepEqual(snapshotTree(cwd), beforeRecover, '(iter-2) the refused forced recovery mutates nothing anywhere under .handoff/');
  });

  it('(F2) cross-host owner: checkpoint soft-refuses (tree untouched) and recoverLock --force refuses', async () => {
    const cwd = writeBundleRepo('baton-e2e-xhost-', 'claude-code', 'open');
    const p = bundlePaths(cwd);
    nodeFs.mkdirSync(p.lockDir, { recursive: true });
    const foreignOwner = JSON.stringify({ host: 'another-machine', pid: 5, startTime: 1, fencingToken: 'X', acquiredAt: NOW, heartbeatAt: NOW });
    nodeFs.writeFileSync(`${p.lockDir}/owner.json`, foreignOwner);
    const before = snapshotTree(cwd);

    const ck = makeRealIo(cwd, { stdin: evt({ type: 'decision', payload: { summary: 'under-cross-host-lock' } }, 'xhost-1', { sessionHint: 'orig-sess' }) });
    const code = await cmdCheckpoint(['--platform', 'claude-code'], ck);
    assert.equal(code, 0, 'a cross-host refusal is still hook-safe (exit 0)');
    assert.match(ck.stderrText(), /host/i, 'the warning names the cross-host cause');
    assert.deepEqual(snapshotTree(cwd), before, 'a cross-host refusal mutates nothing');

    const beforeRecover = snapshotTree(cwd);
    const r = recoverLock(cwd, makeRealIo(cwd, { processAlive: () => false }), { force: true });
    assert.equal(r.recovered, false, 'a cross-host lock is never provably safe to steal, even with force (real fs)');
    assert.equal(nodeFs.readFileSync(`${p.lockDir}/owner.json`, 'utf8'), foreignOwner, 'the cross-host owner.json is byte-for-byte intact');
    assert.deepEqual(snapshotTree(cwd), beforeRecover, '(iter-2) the refused forced recovery mutates nothing anywhere under .handoff/');
  });

  it('(F2) live same-host owner: recoverLock --force is refused, told to terminate the process, lock intact', async () => {
    const cwd = writeBundleRepo('baton-e2e-liveforce-', 'claude-code', 'open');
    const p = bundlePaths(cwd);
    nodeFs.mkdirSync(p.lockDir, { recursive: true });
    const liveOwner = JSON.stringify({ host: 'e2e-host', pid: 777, startTime: 42, fencingToken: 'L', acquiredAt: NOW, heartbeatAt: NOW });
    nodeFs.writeFileSync(`${p.lockDir}/owner.json`, liveOwner);

    const beforeRecover = snapshotTree(cwd);
    const io = makeRealIo(cwd, { processAlive: (pid) => pid === 777 || pid === 4242 });
    const r = recoverLock(cwd, io, { force: true });
    assert.equal(r.recovered, false, 'force NEVER recovers a live same-host owner');
    assert.match(r.refusedReason, /terminate|live|alive|running|777/i, 'the refusal says to terminate the live process');
    assert.equal(nodeFs.readFileSync(`${p.lockDir}/owner.json`, 'utf8'), liveOwner, 'the live owner lock is byte-for-byte intact');
    assert.deepEqual(snapshotTree(cwd), beforeRecover, '(iter-2) the refused forced recovery mutates nothing anywhere under .handoff/');
  });

  it('(F2, staged per E6) pause-after-final-fence-check: a holder that paused past its last check fast-aborts, the write never lands', async () => {
    const cwd = writeBundleRepo('baton-e2e-fence-', 'claude-code', 'open');
    const p = bundlePaths(cwd);
    const io = makeRealIo(cwd);
    const guardedTarget = `${p.dir}/fence-guarded-write.json`;
    let fenceError = null;
    let guardedRan = false;

    withLock(cwd, io, (token) => {
      // First guarded write while current: proceeds.
      const ok = guardedWrite(cwd, io, token, () => 'went-through');
      assert.equal(ok, 'went-through');

      // The competing takeover: owner.json is republished with a new token on the
      // REAL disk while this holder is paused past its final token check.
      const owner = JSON.parse(nodeFs.readFileSync(`${p.lockDir}/owner.json`, 'utf8'));
      nodeFs.writeFileSync(`${p.lockDir}/owner.json`, JSON.stringify({ ...owner, fencingToken: 'STOLEN-BY-COMPETITOR' }));

      // The paused holder resumes and attempts its write: must fast-abort.
      try {
        guardedWrite(cwd, io, token, () => {
          guardedRan = true;
          nodeFs.writeFileSync(guardedTarget, '{"clobbered":true}');
        });
      } catch (e) {
        fenceError = e;
      }
    });

    assert.ok(fenceError, 'the stale holder aborts instead of clobbering');
    assert.equal(fenceError.name, 'FencingError', 'the abort is the fencing layer');
    assert.equal(guardedRan, false, 'the guarded fn never ran after the fence check failed');
    assert.equal(nodeFs.existsSync(guardedTarget), false, 'the stale write never landed on the real fs');

    // (iter-2) The clobber check extends to RELEASE: after withLock returns, the
    // stale holder's finally-path must not have deleted or rewritten the
    // competitor's lock — release is fence-guarded, like every other write.
    assert.ok(nodeFs.existsSync(`${p.lockDir}/owner.json`), "the competitor's lock survives the stale holder's release path");
    assert.equal(
      JSON.parse(nodeFs.readFileSync(`${p.lockDir}/owner.json`, 'utf8')).fencingToken,
      'STOLEN-BY-COMPETITOR',
      "the competitor's fencing token is untouched after the stale holder exits",
    );
    nodeFs.rmSync(p.lockDir, { recursive: true, force: true }); // test-owned cleanup of the staged competitor lock
  });

  it('(F2) prepare-vs-checkpoint race: an intervening checkpoint stales the token; the commit is rejected and mutates nothing', async () => {
    const cwd = writeBundleRepo('baton-e2e-race-', 'claude-code', 'sealed');

    const prep = makeRealIo(cwd, { now: NOW });
    assert.equal(await cmdReceive(['--platform', 'codex', '--prepare', '--origin', 'claude-code', '--reason', CC_LIMIT, '--json'], prep), 0);
    const { token } = JSON.parse(prep.stdoutText()).data;

    // The race: the origin session lands one more checkpoint after prepare.
    const ck = makeRealIo(cwd, { stdin: evt({ type: 'decision', payload: { summary: 'intervening-turn' } }, 'race-1', { sessionHint: 'orig-sess' }) });
    assert.equal(await cmdCheckpoint(['--platform', 'claude-code'], ck), 0);
    const afterCheckpoint = snapshotTree(cwd);

    const commitIo = makeRealIo(cwd, { now: NOW });
    const code = await cmdReceive(['--platform', 'codex', '--commit', token, '--origin', 'claude-code', '--reason', CC_LIMIT, '--json'], commitIo);
    assert.equal(code, 1, 'the raced token is rejected (bundle revision drifted)');
    assert.match(commitIo.stdoutText(), /re-?prepare|stale|drift/i, 'the rejection names re-prepare');
    assert.deepEqual(snapshotTree(cwd), afterCheckpoint, 'the rejected commit leaves the entire .handoff/ tree byte-identical');
    assert.equal(loadBundle(cwd, makeRealIo(cwd)).bundle.generation, 1, 'no generation opened');
  });

  it('(F2) foreign-session rejection: a stable foreign hint is refused (exit 0, tree untouched, --take-over named)', async () => {
    const cwd = writeBundleRepo('baton-e2e-foreign-', 'claude-code', 'open', {
      decisions: [{ seq: 1, ts: NOW, summary: 'belongs-to-orig' }],
      journalSeq: 1,
    });
    const before = snapshotTree(cwd);

    const io = makeRealIo(cwd, { stdin: evt({ type: 'decision', payload: { summary: 'from-intruder' } }, 'foreign-1', { sessionHint: 'intruder-sess' }) });
    const code = await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.equal(code, 0, 'foreign-session rejection is still exit 0 (hook safety)');
    assert.match(io.stderrText(), /--take-over/, 'the warning names the --take-over escape hatch');
    assert.deepEqual(snapshotTree(cwd), before, 'the rejected foreign event leaves the real tree byte-identical');
  });

  it('(F2) --take-over: archives the active bundle and starts fresh, owned by the incoming session', async () => {
    const cwd = writeBundleRepo('baton-e2e-takeover-', 'claude-code', 'open', {
      decisions: [{ seq: 1, ts: NOW, summary: 'OLD-DECISION' }],
      journalSeq: 1,
    });

    const io = makeRealIo(cwd, { stdin: evt({ type: 'decision', payload: { summary: 'from-intruder' } }, 'takeover-1', { sessionHint: 'intruder-sess' }) });
    const code = await cmdCheckpoint(['--platform', 'codex', '--take-over'], io);
    assert.equal(code, 0);

    const history = nodeFs.readdirSync(bundlePaths(cwd).historyDir);
    assert.ok(history.some((n) => /\.takeover\.json$/.test(n)), 'the prior bundle is archived as a takeover rotation on the real fs');

    const fresh = loadBundle(cwd, makeRealIo(cwd)).bundle;
    assert.equal(fresh.origin.sessionHint, 'intruder-sess', 'the fresh bundle is owned by the taking-over session');
    assert.equal(fresh.origin.platform, 'codex', 'the fresh bundle adopts the taking-over platform');
    assert.ok(fresh.decisions.some((d) => d.summary === 'from-intruder'), 'the new event applies to the fresh bundle');
    assert.ok(!fresh.decisions.some((d) => d.summary === 'OLD-DECISION'), 'the fresh bundle does not inherit the archived session state');
  });

  it('(F2) double-commit: the second commit of an already-spent token is an idempotent no-op, no second archive or generation', async () => {
    // CONTRACT EVOLUTION (surface-audit fold, re-entered verification): the
    // same receiver replaying its own receipt now reports alreadyCommitted
    // (exit 0) instead of a stale rejection whose re-prepare instruction caused
    // duplicate receives. The safety invariants are unchanged and asserted:
    // zero tree change, one archive, one generation bump.
    const cwd = writeBundleRepo('baton-e2e-double-', 'claude-code', 'sealed');

    const prep = makeRealIo(cwd, { now: NOW });
    assert.equal(await cmdReceive(['--platform', 'codex', '--prepare', '--origin', 'claude-code', '--reason', CC_LIMIT, '--json'], prep), 0);
    const { token } = JSON.parse(prep.stdoutText()).data;

    assert.equal(await cmdReceive(['--platform', 'codex', '--commit', token, '--origin', 'claude-code', '--reason', CC_LIMIT, '--json'], makeRealIo(cwd, { now: NOW })), 0, 'the first commit succeeds');
    const afterFirst = snapshotTree(cwd);

    const io2 = makeRealIo(cwd, { now: NOW });
    const code2 = await cmdReceive(['--platform', 'codex', '--commit', token, '--origin', 'claude-code', '--reason', CC_LIMIT, '--json'], io2);
    assert.equal(code2, 0, 'the replayed receipt is an idempotent success');
    assert.match(io2.stdoutText(), /alreadyCommitted/, 'the envelope reports alreadyCommitted');
    assert.deepEqual(snapshotTree(cwd), afterFirst, 'the idempotent double-commit changes nothing');
    assert.equal(receiveFreezes(cwd).length, 1, 'no second receive archive is created');
    assert.equal(loadBundle(cwd, makeRealIo(cwd)).bundle.generation, 2, 'the generation did not advance again');
  });

  it('competing receivers: the first commit wins, the second (now-stale) token is rejected requiring re-prepare', async () => {
    const cwd = writeBundleRepo('baton-e2e-compete-', 'claude-code', 'sealed');

    const prep1 = makeRealIo(cwd, { now: NOW });
    assert.equal(await cmdReceive(['--platform', 'codex', '--prepare', '--origin', 'claude-code', '--reason', CC_LIMIT, '--json'], prep1), 0);
    const t1 = JSON.parse(prep1.stdoutText()).data.token;
    const prep2 = makeRealIo(cwd, { now: NOW });
    assert.equal(await cmdReceive(['--platform', 'cursor', '--prepare', '--origin', 'claude-code', '--reason', CC_LIMIT, '--json'], prep2), 0);
    const t2 = JSON.parse(prep2.stdoutText()).data.token;

    assert.equal(await cmdReceive(['--platform', 'codex', '--commit', t1, '--origin', 'claude-code', '--reason', CC_LIMIT, '--json'], makeRealIo(cwd, { now: NOW })), 0, 'the first receiver commits');

    const io2 = makeRealIo(cwd, { now: NOW });
    const code2 = await cmdReceive(['--platform', 'cursor', '--commit', t2, '--origin', 'claude-code', '--reason', CC_LIMIT, '--json'], io2);
    assert.equal(code2, 1, 'the competing receiver commit is rejected — the bundle revision moved under it');
    assert.match(io2.stdoutText(), /re-?prepare|stale|drift/i, 'the rejection tells the loser to re-prepare');
    assert.equal(loadBundle(cwd, makeRealIo(cwd)).bundle.origin.platform, 'codex', 'the winner keeps ownership');
  });

  it('prepare-without-commit: prepare mutates nothing and leaves the bundle sealed + receivable', async () => {
    const cwd = writeBundleRepo('baton-e2e-prep-', 'claude-code', 'sealed');
    const before = snapshotTree(cwd);

    const io = makeRealIo(cwd, { now: NOW });
    assert.equal(await cmdReceive(['--platform', 'codex', '--prepare', '--origin', 'claude-code', '--reason', CC_LIMIT, '--json'], io), 0);

    assert.deepEqual(snapshotTree(cwd), before, 'prepare is read-only — no state changes without commit');
    assert.equal(loadBundle(cwd, makeRealIo(cwd)).bundle.handoff.status, 'sealed', 'the bundle is untouched and still receivable');
  });
});
