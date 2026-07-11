import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { prepare, commit } from '../../core/src/receive/txn.mjs';
import { loadBundle, bundlePaths, appendJournal } from '../../core/src/bundle/store.mjs';

// ---------------------------------------------------------------------------
// Contract choices for core/src/receive/txn.mjs (docs/design/core.md §Module APIs
// prepare/commit; §Per-module test lists "txn"; plan §Concurrency — the receive
// prepare/commit two-phase transaction, receipt-token bindings incl. the
// content-sensitive git digest, open->received degraded seal, ownership adoption +
// new generation, chained failover, competing receivers, double-commit).
//
// SIGNATURES (pinned — the task overrides core.md's 3-arg commit):
//   prepare(root, opts, io) -> { token, prompt, assignments, warnings }
//   commit(root, token, opts, io) -> { adopted, generation, archivedTo }
//   Both are SYNCHRONOUS. The plan pins that the receive COMMAND wires
//   core/src/git/snapshot.mjs in and passes the result as opts.gitSnapshot; txn
//   itself never spawns git — it takes the snapshot as plain data.
//
//   opts (same shape for prepare and commit):
//     { platform,       // destination harness we are resuming ON (e.g. 'codex')
//       origin,         // intake: the harness handed off FROM (e.g. 'claude-code')
//       reason,         // intake: why the switch happened (free text)
//       gitSnapshot,    // the caller-computed git snapshot object (git/snapshot.mjs)
//       probes,         // optional probe map for resolveRoles (default null)
//       sessionHint }   // the RECEIVING session's hint, used for ownership adoption
//
// TOKEN BINDING (THE pin). prepare captures a REVISION FINGERPRINT and returns it
//   as an opaque token. It binds every one of these inputs (one rejection test per
//   input below — verifier fold F3 completed the set):
//     - bundle REVISION: generation + journalSeq (as loadBundle reports them)
//     - intake: origin + reason
//     - config digest: a hash of the baton.config.json bytes at <root>
//     - GIT digest: a hash of the WHOLE opts.gitSnapshot object (PIN — the git
//       state is bound by hashing the caller-passed object, so headSha, dirty,
//       AND contentDigest are each binding: a HEAD move with an UNCHANGED
//       contentDigest still drifts the token, and vice versa)
//     - probe snapshot: a hash of opts.probes
//     - target platform (opts.platform)
//     - receiving session (opts.sessionHint) — plan: the token binds "target
//       platform+session"
//   prepare mutates NOTHING (it cannot persist a "prepared" record — the token is
//   self-contained). commit RE-DERIVES every bound input from current disk state +
//   its own opts and compares to the token; ANY drift throws an Error whose message
//   names re-prepare (matches /re-?prepare/i) and performs NO mutation (the
//   .handoff tree is byte-identical before and after the rejected commit). Because
//   a successful commit bumps `generation`, an already-spent token (double-commit)
//   and a losing competitor's token (competing receivers) both fail the revision
//   check with no extra bookkeeping.
//
// COMMIT SUCCESS (one atomic transition):
//   - Archives the current bundle to history/ via rotateJournal kind 'receive'
//     (a history/<stem>.receive.json + .ndjson pair). archivedTo === that stem.
//     The archived .receive freeze is the RECEIVED seal (handoff.status
//     'received' — asserted on BOTH the sealed and open paths, verifier fold F7:
//     archiving the pre-commit sealed bundle unchanged would be wrong); it
//     retains the receipt data (the receive_log entry for THIS receive rides in
//     the archived freeze). For an OPEN source bundle it is the receive-generated
//     DEGRADED seal (handoff.reason from intake, reasonClass classified from the
//     reason text against the intake ORIGIN platform via the built-in signature
//     table); for a SEALED source the finalize reason/reasonClass are retained.
//   - Adopts ownership: origin becomes the RECEIVING side — origin.platform ===
//     opts.platform, origin.sessionHint === opts.sessionHint.
//   - Opens a fresh writable generation: generation + 1, handoff.status 'open'.
//   - Appends a receive_log entry { origin, reason, at }; for the OPEN (degraded)
//     path the entry additionally carries degradedSeal: true (PIN: that flag lives
//     on the receive_log entry). The sealed path's entry has NO truthy degradedSeal.
//   - Returns { adopted: <truthy>, generation: <new gen>, archivedTo: <stem> }.
//
// STALENESS (prepare warnings, plan §Receive): OPEN source bundle -> a warning
//   notes the missing seal; age > 12h (now - finalizedAt), HEAD moved
//   (bundle.git.headSha !== opts.gitSnapshot.headSha), and a dirty mismatch each
//   add a warning. Asserted as substring matches, not byte-exact strings.
//
// All txn tests seed: the bundle, baton.config.json at <root>, AND the built-in
// signature table at its module-resolved path (loadSignatures reads via io.fs), so
// role resolution and reasonClass classification both work over memfs.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
// The exact path txn resolves for the built-in table (core/src/receive ->
// ../../data), so seeding it here makes loadSignatures(io) succeed over memfs.
const SIG_PATH = join(repoRoot, 'core', 'data', 'signatures.v1.json');
const SIG_CONTENT = readFileSync(SIG_PATH, 'utf8');

const ROOT = '/repo';
const NOW = '2026-07-11T00:00:00.000Z';

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
const CONFIG_TEXT = JSON.stringify(CONFIG, null, 2);

// A git snapshot as core/src/git/snapshot.mjs would return; headSha matches the
// bundle's captured git so the non-stale tests raise no HEAD-moved warning.
const G1 = { branch: 'main', headSha: 'abc123', dirty: false, dirtySummary: [], contentDigest: 'gd-1' };
const G2 = { branch: 'main', headSha: 'abc123', dirty: false, dirtySummary: [], contentDigest: 'gd-2-CHANGED' };

const snapText = (b) => JSON.stringify(b, null, 2) + '\n';

function baseBundle(overrides = {}) {
  return {
    schema: 'baton/bundle@1',
    bundleId: 'b_txn0000000000',
    generation: 1,
    createdAt: NOW,
    updatedAt: NOW,
    origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: 'sess-A', unstable: false },
    task: { goal: 'Wire the receive transaction', constraints: [], acceptance: [] },
    plan: { steps: [{ id: 's1', title: 'Bind the token', status: 'active', note: null }] },
    decisions: [],
    files: { touched: [] },
    roles: { assignments: {} },
    git: { branch: 'main', headSha: 'abc123', dirty: false, dirtySummary: [], contentDigest: 'd0', summaryTruncated: false },
    handoff: { status: 'open', reason: null, reasonClass: null, toPlatformHint: null, finalizedAt: null, receive_log: [] },
    journalSeq: 5,
    compaction: { droppedDecisions: 0, note: null },
    dedupeRing: [],
    ...overrides,
  };
}

function sealedBundle(overrides = {}) {
  return baseBundle({
    handoff: { status: 'sealed', reason: "You've hit your usage limit", reasonClass: 'usage-limit', toPlatformHint: 'codex', finalizedAt: NOW, receive_log: [] },
    ...overrides,
  });
}

function openBundle(overrides = {}) {
  return baseBundle({ handoff: { status: 'open', reason: null, reasonClass: null, toPlatformHint: null, finalizedAt: null, receive_log: [] }, ...overrides });
}

function makeTxnIo({ bundle, journal, configText = CONFIG_TEXT, now = NOW, extra = {} } = {}) {
  const files = {
    [SIG_PATH]: SIG_CONTENT,
    [`${ROOT}/baton.config.json`]: configText,
    [`${ROOT}/.handoff/bundle.json`]: snapText(bundle),
    ...extra,
  };
  if (journal !== undefined) files[`${ROOT}/.handoff/journal.ndjson`] = journal;
  return makeIo({ files, now });
}

// Standard opts for a claude-code -> codex receive.
function opts(overrides = {}) {
  return { platform: 'codex', origin: 'claude-code', reason: 'switching to codex', gitSnapshot: G1, probes: null, sessionHint: 'codex-sess-1', ...overrides };
}

const readHistoryFreeze = (io, stem) => JSON.parse(io.fs.readFileSync(`${bundlePaths(ROOT).historyDir}/${stem}.json`, 'utf8'));

// ===========================================================================
describe('receive-txn.prepare — sealed bundle', () => {
  it('returns {token, prompt, assignments, warnings} and mutates NOTHING', () => {
    const io = makeTxnIo({ bundle: sealedBundle() });
    const before = io.files();

    const out = prepare(ROOT, opts(), io);

    assert.ok(typeof out.token === 'string' && out.token.length > 0, 'token is an opaque non-empty string');
    assert.ok(typeof out.prompt === 'string', 'prompt is a string (from receive/prompt.mjs)');
    assert.ok(out.prompt.includes('Wire the receive transaction'), 'prompt carries the goal (delegation to prompt.mjs)');
    assert.ok(out.prompt.includes('unverified claims to check against the working tree'), 'prompt carries the claims posture');
    assert.ok(out.assignments && typeof out.assignments === 'object', 'assignments is an object');
    assert.deepEqual(Object.keys(out.assignments), Object.keys(CONFIG.roles), 'one assignment per configured role');
    assert.ok(Array.isArray(out.warnings), 'warnings is an array');

    assert.deepEqual(io.files(), before, 'prepare is read-only: no file may change');
  });

  it('the token is opaque and different from a token bound to a different intake', () => {
    const io = makeTxnIo({ bundle: sealedBundle() });
    const t1 = prepare(ROOT, opts({ reason: 'reason one' }), io).token;
    const t2 = prepare(ROOT, opts({ reason: 'reason two' }), io).token;
    assert.notEqual(t1, t2, 'binding a different reason yields a different token');
  });
});

// ===========================================================================
describe('receive-txn.prepare — open bundle (limit death, no seal)', () => {
  it('works and warns about the missing seal', () => {
    const io = makeTxnIo({ bundle: openBundle() });
    const out = prepare(ROOT, opts(), io);
    assert.ok(typeof out.token === 'string' && out.token.length > 0);
    assert.ok(
      out.warnings.some((w) => typeof w === 'string' && /seal|unseal|open|degrad/i.test(w)),
      'an open (unsealed) source bundle must surface a missing-seal warning',
    );
  });

  it('surfaces staleness warnings: age > 12h, HEAD moved, and a dirty mismatch', () => {
    const staleBundle = sealedBundle({
      handoff: { status: 'sealed', reason: 'r', reasonClass: 'usage-limit', toPlatformHint: 'codex', finalizedAt: '2026-07-10T04:00:00.000Z', receive_log: [] },
      git: { branch: 'main', headSha: 'OLDsha', dirty: false, dirtySummary: [], contentDigest: 'd0', summaryTruncated: false },
    });
    const io = makeTxnIo({ bundle: staleBundle, now: NOW });
    // gitSnapshot reports a MOVED head and a dirty tree — both diverge from capture.
    const movedDirty = { branch: 'main', headSha: 'NEWsha', dirty: true, dirtySummary: [' M x.mjs'], contentDigest: 'gd-x' };
    const out = prepare(ROOT, opts({ gitSnapshot: movedDirty }), io);
    const joined = out.warnings.join('\n');
    assert.match(joined, /12|stale|h ago|hour/i, 'age > 12h must warn');
    assert.match(joined, /HEAD|head/, 'a moved HEAD must warn');
    assert.match(joined, /dirt/i, 'a dirty mismatch must warn');
  });
});

// ===========================================================================
describe('receive-txn.commit — sealed -> received (normal), ownership adoption + new generation', () => {
  it('archives via rotateJournal "receive", adopts the receiver as owner, opens generation+1, appends receive_log', () => {
    const io = makeTxnIo({ bundle: sealedBundle(), journal: '' });
    const { token } = prepare(ROOT, opts(), io);

    const res = commit(ROOT, token, opts(), io);

    assert.ok(res.adopted, 'commit reports adoption');
    assert.equal(res.generation, 2, 'a fresh writable generation is opened (1 -> 2)');
    assert.ok(typeof res.archivedTo === 'string' && res.archivedTo.endsWith('.receive'), 'archivedTo is the receive rotation stem');

    // A "receive" rotation landed in history.
    const names = io.fs.readdirSync(bundlePaths(ROOT).historyDir);
    assert.ok(names.some((n) => /\.receive\.json$/.test(n)), 'a receive freeze exists in history/');

    // The live bundle: adopted owner, open, gen 2, receive_log appended.
    const { bundle } = loadBundle(ROOT, io);
    assert.equal(bundle.generation, 2);
    assert.equal(bundle.handoff.status, 'open', 'the new live generation is writable (open)');
    assert.equal(bundle.origin.platform, 'codex', 'ownership adopted to the receiving platform');
    assert.equal(bundle.origin.sessionHint, 'codex-sess-1', 'ownership adopted to the receiving session');
    const entry = bundle.handoff.receive_log.at(-1);
    assert.ok(entry, 'a receive_log entry was appended');
    assert.equal(entry.origin, 'claude-code', 'receive_log records the intake origin');
    assert.equal(entry.reason, 'switching to codex', 'receive_log records the intake reason');
    assert.ok(typeof entry.at === 'string' && entry.at.length > 0, 'receive_log records a timestamp');
    assert.ok(!entry.degradedSeal, 'a sealed->received commit is NOT a degraded seal');
  });

  it('(F7) the archived freeze is the RECEIVED seal with receipt data, not the pre-commit sealed bundle', () => {
    const io = makeTxnIo({ bundle: sealedBundle(), journal: '' });
    const { token } = prepare(ROOT, opts(), io);
    const res = commit(ROOT, token, opts(), io);

    const seal = readHistoryFreeze(io, res.archivedTo);
    assert.equal(seal.handoff.status, 'received', 'the archived freeze records the sealed->received transition');
    assert.equal(seal.handoff.reason, "You've hit your usage limit", 'the finalize reason is retained on the archived seal');
    assert.equal(seal.handoff.reasonClass, 'usage-limit', 'the finalize reasonClass is retained');

    const archived = seal.handoff.receive_log.at(-1);
    assert.ok(archived, 'the archived seal retains the receive_log receipt data for this receive');
    assert.equal(archived.origin, 'claude-code');
    assert.equal(archived.reason, 'switching to codex');
    assert.ok(typeof archived.at === 'string' && archived.at.length > 0);
  });
});

// ===========================================================================
describe('receive-txn.commit — open -> received (degraded seal)', () => {
  it('writes a degraded seal: receive_log entry {degradedSeal:true}, reasonClass classified from the reason', () => {
    // A usage-limit reason string for the claude-code origin -> classifies usage-limit.
    const reason = "You've hit your session limit · resets 3pm";
    const io = makeTxnIo({ bundle: openBundle(), journal: '' });
    const o = opts({ reason });
    const { token } = prepare(ROOT, o, io);

    const res = commit(ROOT, token, o, io);
    assert.equal(res.generation, 2);

    const { bundle } = loadBundle(ROOT, io);
    const entry = bundle.handoff.receive_log.at(-1);
    assert.equal(entry.degradedSeal, true, 'PIN: the degraded flag lives on the receive_log entry');
    assert.equal(entry.origin, 'claude-code');
    assert.equal(entry.reason, reason);

    // The archived "receive" freeze is the degraded seal: status received, reason
    // from intake, reasonClass classified from the reason text (origin platform).
    const seal = readHistoryFreeze(io, res.archivedTo);
    assert.equal(seal.handoff.status, 'received', 'the archived freeze is the received seal');
    assert.equal(seal.handoff.reason, reason, 'the degraded seal records the intake reason');
    assert.equal(seal.handoff.reasonClass, 'usage-limit', 'reasonClass is classified from the reason text');
  });
});

// ===========================================================================
describe('receive-txn — chained failover A -> B -> C (checkpoints fired after each receive, F8)', () => {
  // Plan §Concurrency: "chained A→B→C failover is contract-tested with checkpoints
  // fired immediately after each receive". At this altitude a checkpoint is a
  // journal append from the ADOPTED session; first-party = the event's sessionHint
  // matches the live bundle's adopted origin.sessionHint and the event folds in.
  it('receives twice with a first-party checkpoint after each; generations 1->2->3, ownership claude-code->codex->cursor', () => {
    const io = makeTxnIo({ bundle: sealedBundle(), journal: '' });

    // A (claude-code) -> B (codex).
    const oAB = opts({ platform: 'codex', origin: 'claude-code', reason: 'A hit limit', sessionHint: 'codex-s' });
    const rAB = commit(ROOT, prepare(ROOT, oAB, io).token, oAB, io);
    assert.equal(rAB.generation, 2);

    // Checkpoint immediately after the receive, from the adopted session.
    appendJournal(ROOT, { type: 'decision', dedupeKey: 'ck-B', source: 'stop', ts: NOW, sessionHint: 'codex-s', payload: { summary: 'B-first-party' } }, io);
    const afterB = loadBundle(ROOT, io).bundle;
    assert.equal(afterB.origin.platform, 'codex');
    assert.equal(afterB.origin.sessionHint, 'codex-s', 'the checkpointing session IS the adopted owner — first-party by the isolation rule');
    assert.ok(afterB.decisions.some((d) => d.summary === 'B-first-party'), "the adopted session's checkpoint folds into the new generation");

    // B (codex, now the open owner) -> C (cursor). Prepared AFTER the checkpoint,
    // so the fresh token binds the moved journalSeq — the intervening first-party
    // checkpoint does NOT block a subsequent receive.
    const oBC = opts({ platform: 'cursor', origin: 'codex', reason: "You've hit your usage limit", sessionHint: 'cursor-s' });
    const rBC = commit(ROOT, prepare(ROOT, oBC, io).token, oBC, io);
    assert.equal(rBC.generation, 3, 'the second receive opens generation 3');

    // Checkpoint immediately after the second receive, from the newly adopted session.
    appendJournal(ROOT, { type: 'decision', dedupeKey: 'ck-C', source: 'stop', ts: NOW, sessionHint: 'cursor-s', payload: { summary: 'C-first-party' } }, io);
    const afterC = loadBundle(ROOT, io).bundle;
    assert.equal(afterC.generation, 3);
    assert.equal(afterC.origin.platform, 'cursor', 'ownership walked to the final receiver');
    assert.equal(afterC.origin.sessionHint, 'cursor-s');
    assert.ok(afterC.decisions.some((d) => d.summary === 'C-first-party'), "the second receiver's checkpoint is first-party too");
  });
});

// ===========================================================================
describe('receive-txn.commit — token-binding rejections (one per bound input)', () => {
  // Each: prepare a token, introduce ONE drift, then commit must throw naming
  // re-prepare and leave the .handoff tree byte-identical to its pre-commit state.
  const expectRejectedNoMutation = (io, doCommit) => {
    const before = io.files();
    assert.throws(doCommit, /re-?prepare/i, 'a bound-input drift must be rejected with an instruction to re-prepare');
    assert.deepEqual(io.files(), before, 'a rejected commit must mutate nothing');
  };

  it('intervening checkpoint (journalSeq moved) -> rejected', () => {
    const io = makeTxnIo({ bundle: sealedBundle(), journal: '' });
    const { token } = prepare(ROOT, opts(), io);
    // An intervening mechanical checkpoint advances the journal past the bound seq.
    appendJournal(ROOT, { type: 'note', dedupeKey: 'intervening', source: 'stop', ts: NOW, payload: { text: 'a later turn' } }, io);
    expectRejectedNoMutation(io, () => commit(ROOT, token, opts(), io));
  });

  it('config digest change (baton.config.json edited) -> rejected', () => {
    const io = makeTxnIo({ bundle: sealedBundle(), journal: '' });
    const { token } = prepare(ROOT, opts(), io);
    // Edit the config to a still-valid but different byte sequence.
    const edited = { ...CONFIG, platforms: { ...CONFIG.platforms, cursor: { enabled: true } } };
    io.fs.writeFileSync(`${ROOT}/baton.config.json`, JSON.stringify(edited, null, 2));
    expectRejectedNoMutation(io, () => commit(ROOT, token, opts(), io));
  });

  it('git digest change (opts.gitSnapshot differs at commit) -> rejected (PIN: git state bound by hashing the snapshot)', () => {
    const io = makeTxnIo({ bundle: sealedBundle(), journal: '' });
    const { token } = prepare(ROOT, opts({ gitSnapshot: G1 }), io);
    // Same file marked M but recontented -> a different contentDigest in the snapshot.
    expectRejectedNoMutation(io, () => commit(ROOT, token, opts({ gitSnapshot: G2 }), io));
  });

  it('(F3) HEAD move with an UNCHANGED contentDigest -> rejected (headSha is bound in its own right)', () => {
    const io = makeTxnIo({ bundle: sealedBundle(), journal: '' });
    const { token } = prepare(ROOT, opts({ gitSnapshot: G1 }), io);
    // Someone committed between prepare and commit: HEAD moved, the work-tree
    // content digest happens to be identical. Still a drift.
    const headMoved = { ...G1, headSha: 'def999MOVED' };
    expectRejectedNoMutation(io, () => commit(ROOT, token, opts({ gitSnapshot: headMoved }), io));
  });

  it('(F3) target platform drift (prepared for codex, committed for cursor) -> rejected', () => {
    const io = makeTxnIo({ bundle: sealedBundle(), journal: '' });
    const { token } = prepare(ROOT, opts({ platform: 'codex' }), io);
    expectRejectedNoMutation(io, () => commit(ROOT, token, opts({ platform: 'cursor' }), io));
  });

  it('(F3) receiving sessionHint drift between prepare and commit -> rejected', () => {
    const io = makeTxnIo({ bundle: sealedBundle(), journal: '' });
    const { token } = prepare(ROOT, opts({ sessionHint: 'codex-sess-1' }), io);
    expectRejectedNoMutation(io, () => commit(ROOT, token, opts({ sessionHint: 'codex-sess-2' }), io));
  });

  it('intake change (origin differs) -> rejected', () => {
    const io = makeTxnIo({ bundle: sealedBundle(), journal: '' });
    const { token } = prepare(ROOT, opts({ origin: 'claude-code' }), io);
    expectRejectedNoMutation(io, () => commit(ROOT, token, opts({ origin: 'cursor' }), io));
  });

  it('intake change (reason differs) -> rejected', () => {
    const io = makeTxnIo({ bundle: sealedBundle(), journal: '' });
    const { token } = prepare(ROOT, opts({ reason: 'reason at prepare' }), io);
    expectRejectedNoMutation(io, () => commit(ROOT, token, opts({ reason: 'a different reason at commit' }), io));
  });

  it('probes change (opts.probes differs) -> rejected', () => {
    const io = makeTxnIo({ bundle: sealedBundle(), journal: '' });
    const P1 = { codex: { capability: 'authenticated', outcome: 'ok' } };
    const P2 = { codex: { capability: 'reachable', outcome: 'ok' } };
    const { token } = prepare(ROOT, opts({ probes: P1 }), io);
    expectRejectedNoMutation(io, () => commit(ROOT, token, opts({ probes: P2 }), io));
  });
});

// ===========================================================================
describe('receive-txn.commit — double-commit and competing receivers', () => {
  it('double-commit: the second commit of a spent token is rejected (revision moved), state untouched', () => {
    const io = makeTxnIo({ bundle: sealedBundle(), journal: '' });
    const { token } = prepare(ROOT, opts(), io);

    const first = commit(ROOT, token, opts(), io);
    assert.equal(first.generation, 2, 'the first commit succeeds');

    const before = io.files();
    assert.throws(() => commit(ROOT, token, opts(), io), /re-?prepare/i, 'the spent token can no longer commit');
    assert.deepEqual(io.files(), before, 'the rejected second commit mutates nothing');
    assert.equal(loadBundle(ROOT, io).bundle.generation, 2, 'the generation did not advance a second time');
  });

  it('competing receivers: two prepares, the first commit wins and the second is rejected', () => {
    const io = makeTxnIo({ bundle: sealedBundle(), journal: '' });
    const oCodex = opts({ platform: 'codex', sessionHint: 'codex-s' });
    const oCursor = opts({ platform: 'cursor', sessionHint: 'cursor-s' });
    const t1 = prepare(ROOT, oCodex, io).token;
    const t2 = prepare(ROOT, oCursor, io).token;

    const won = commit(ROOT, t1, oCodex, io);
    assert.equal(won.generation, 2);
    assert.equal(loadBundle(ROOT, io).bundle.origin.platform, 'codex', 'the winner adopted ownership');

    const before = io.files();
    assert.throws(() => commit(ROOT, t2, oCursor, io), /re-?prepare/i, 'the losing competitor is rejected');
    assert.deepEqual(io.files(), before, 'the rejected competitor mutates nothing');
    assert.equal(loadBundle(ROOT, io).bundle.origin.platform, 'codex', 'ownership was not stolen by the loser');
  });
});
