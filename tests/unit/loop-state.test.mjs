import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { defaultLoopSpec } from '../../core/src/loop/spec.mjs';

// ---------------------------------------------------------------------------
// RED — loop run state (subtask loop-state, part A). NEW module: these tests
// DEFINE the API. Source of truth:
// docs/plans/2026-07-18-goal-loop-worktree-pipeline.md §"baton loop (Layer 2)",
// §"Supervisor lifetime and recovery", §"Smoke gate", §"Caps". Mirrors the
// snapshot+journal+replay idioms of core/src/bundle/store.mjs (io.now() for
// time, atomic writes, torn-tail-tolerant NDJSON, seq-skip replay dedup).
//
// TARGET MODULE: core/src/loop/state.mjs.
//
// PINNED EXPORTS (the implementer follows these names):
//   LOOP_STATE_SCHEMA        - 'baton/loop-state@1'
//   LOOP_STATUS              - the frozen status vocabulary
//   LOOP_EVENT               - frozen map of journal event type strings
//   loopPaths(root)          - {dir, state, journal} under <root>/.handoff/loop
//   initLoopState(spec, io)  - pure fresh state, deterministic from io
//   applyLoopEvent(state, ev)- pure reducer (the transitions)
//   writeLoopState(root, state, io)   - atomic snapshot write
//   appendLoopEvent(root, ev, io)     - append a journal event, returns its seq
//   loadLoopState(root, io)  - {state, warnings}: snapshot + torn-tolerant replay
// (smoke-approval token functions are pinned in loop-smoke-token.test.mjs.)
//
// RED MECHANISM: dynamic-import-with-catch + an M() guard, so each test reds on
// a MEANINGFUL assertion ("module must load") rather than a bare import crash.
// ---------------------------------------------------------------------------

let mod = /** @type {any} */ (null);
let importError = /** @type {any} */ (null);
try {
  mod = await import('../../core/src/loop/state.mjs');
} catch (e) {
  importError = e;
}
function M() {
  assert.ok(mod, `core/src/loop/state.mjs must load (import error: ${importError?.message ?? 'none'})`);
  return mod;
}

const SPEC = () => defaultLoopSpec('Ship the widget');
// A steady io: fixed clock/identity so init is deterministic across two builds.
const io = (over = {}) => makeIo({ now: '2026-07-19T00:00:00.000Z', host: 'host-A', pid: 4242, startTime: 111000, fencingSeed: 1, ...over });

// Fold events through the reducer from a starting state.
function fold(applyLoopEvent, state, events) {
  return events.reduce((s, e) => applyLoopEvent(s, e), state);
}

// ===========================================================================
describe('loopPaths — everything under <root>/.handoff/loop', () => {
  it('resolves the snapshot + journal under the loop dir', () => {
    const { loopPaths } = M();
    const p = loopPaths('/repo');
    assert.equal(p.dir, '/repo/.handoff/loop');
    assert.equal(p.state, '/repo/.handoff/loop/state.json');
    assert.equal(p.journal, '/repo/.handoff/loop/journal.ndjson');
  });
});

// ===========================================================================
describe('initLoopState — fresh run captured deterministically from io', () => {
  it('captures schema, goal, phaseIndex 0, zeroed gate counters, status running', () => {
    const { initLoopState, LOOP_STATE_SCHEMA } = M();
    const s = initLoopState(SPEC(), io());
    assert.equal(s.schema, LOOP_STATE_SCHEMA);
    assert.equal(s.schema, 'baton/loop-state@1');
    assert.equal(s.goal, 'Ship the widget');
    assert.equal(s.phaseIndex, 0);
    assert.equal(s.status, 'running');
    assert.ok(typeof s.runId === 'string' && s.runId.length > 0, 'a runId is captured');
    assert.equal(typeof s.iterations, 'object', 'gate counters is an object');
    assert.ok(Object.values(s.iterations).every((/** @type {any} */ n) => n === 0), 'every gate counter starts at 0');
  });

  it('is DETERMINISTIC from injected io — same io facts => identical state (no Date.now/Math.random)', () => {
    const { initLoopState } = M();
    const a = initLoopState(SPEC(), io());
    const b = initLoopState(SPEC(), io());
    assert.deepEqual(a, b, 'runId and all fields derive only from io — two identical ios yield identical state');
  });
});

// ===========================================================================
describe('LOOP_STATUS — the pinned status enum', () => {
  it('is exactly running | awaiting-smoke-approval | parked | escalated | done', () => {
    const { LOOP_STATUS } = M();
    const values = Array.isArray(LOOP_STATUS) ? LOOP_STATUS : Object.values(LOOP_STATUS);
    assert.deepEqual([...values].sort(), ['awaiting-smoke-approval', 'done', 'escalated', 'parked', 'running'].sort());
  });
});

// ===========================================================================
describe('applyLoopEvent — pure transition reducer', () => {
  it('phase-advance moves to the next phase; advancing past the last phase is done', () => {
    const { initLoopState, applyLoopEvent, LOOP_EVENT } = M();
    const spec = SPEC();
    const s0 = initLoopState(spec, io());
    const s1 = applyLoopEvent(s0, { type: LOOP_EVENT.PHASE_ADVANCE });
    assert.equal(s1.phaseIndex, 1);
    assert.equal(s1.status, 'running');
    // Advance through every remaining phase -> done.
    const end = fold(applyLoopEvent, s0, spec.phases.map(() => ({ type: LOOP_EVENT.PHASE_ADVANCE })));
    assert.equal(end.status, 'done', 'completing the last phase transitions to done');
  });

  it('gate-iteration increments a NAMED gate counter with its verdict', () => {
    const { initLoopState, applyLoopEvent, LOOP_EVENT } = M();
    const s0 = initLoopState(SPEC(), io());
    const s1 = applyLoopEvent(s0, { type: LOOP_EVENT.GATE_ITERATION, gate: 'gate-1', verdict: 'BLOCKED' });
    assert.equal(s1.iterations['gate-1'], 1);
    const s2 = applyLoopEvent(s1, { type: LOOP_EVENT.GATE_ITERATION, gate: 'gate-1', verdict: 'BLOCKED' });
    assert.equal(s2.iterations['gate-1'], 2);
    assert.equal(s2.status, 'running');
  });

  it('the 5-cap is a hard invariant: a 6th iteration is REFUSED, the run escalates, never a 6th count', () => {
    const { initLoopState, applyLoopEvent, LOOP_EVENT } = M();
    const s0 = initLoopState(SPEC(), io());
    let s = s0;
    for (let i = 0; i < 5; i += 1) s = applyLoopEvent(s, { type: LOOP_EVENT.GATE_ITERATION, gate: 'gate-2-a', verdict: 'BLOCKED' });
    assert.equal(s.iterations['gate-2-a'], 5, 'five iterations are allowed');
    assert.equal(s.status, 'running');

    const sixth = applyLoopEvent(s, { type: LOOP_EVENT.GATE_ITERATION, gate: 'gate-2-a', verdict: 'BLOCKED' });
    assert.equal(sixth.status, 'escalated', 'a 6th attempt escalates instead of running');
    assert.equal(sixth.iterations['gate-2-a'], 5, 'the counter never reaches 6');
    assert.ok(sixth.escalation, 'an escalation record is written');
    assert.equal(sixth.escalation.gate, 'gate-2-a', 'the record names the gate');
    assert.equal(sixth.escalation.iteration, 5, 'the record names the iteration count');
  });

  it('gate counters are PER-GATE, not global (finding 1)', () => {
    const { initLoopState, applyLoopEvent, LOOP_EVENT } = M();
    const s0 = initLoopState(SPEC(), io());
    let s = s0;
    for (let i = 0; i < 5; i += 1) s = applyLoopEvent(s, { type: LOOP_EVENT.GATE_ITERATION, gate: 'gate-A', verdict: 'BLOCKED' });
    // A DIFFERENT gate starts fresh at 1 and the run keeps running.
    const b = applyLoopEvent(s, { type: LOOP_EVENT.GATE_ITERATION, gate: 'gate-B', verdict: 'BLOCKED' });
    assert.equal(b.iterations['gate-B'], 1, 'gate-B is independent — starts at 1');
    assert.equal(b.iterations['gate-A'], 5, 'gate-A is unchanged by a gate-B iteration');
    assert.equal(b.status, 'running', 'a fresh gate does not trip the cap of another');
    // But a SIXTH on gate-A still escalates (the cap is per-gate, not defeated).
    const sixthA = applyLoopEvent(b, { type: LOOP_EVENT.GATE_ITERATION, gate: 'gate-A', verdict: 'BLOCKED' });
    assert.equal(sixthA.status, 'escalated', 'a 6th on gate-A escalates');
    assert.equal(sixthA.escalation.gate, 'gate-A');
  });

  it('park records a reason; resume returns to running', () => {
    const { initLoopState, applyLoopEvent, LOOP_EVENT } = M();
    const s0 = initLoopState(SPEC(), io());
    const parked = applyLoopEvent(s0, { type: LOOP_EVENT.PARK, reason: 'awaiting operator' });
    assert.equal(parked.status, 'parked');
    assert.equal(parked.parkReason, 'awaiting operator');
    const resumed = applyLoopEvent(parked, { type: LOOP_EVENT.RESUME });
    assert.equal(resumed.status, 'running');
  });

  it('RESUME from ESCALATED is refused — escalation is an operator decision, not a park (finding 5)', () => {
    const { initLoopState, applyLoopEvent, LOOP_EVENT } = M();
    let s = initLoopState(SPEC(), io());
    for (let i = 0; i < 6; i += 1) s = applyLoopEvent(s, { type: LOOP_EVENT.GATE_ITERATION, gate: 'gate-1', verdict: 'BLOCKED' });
    assert.equal(s.status, 'escalated');
    const afterResume = applyLoopEvent(s, { type: LOOP_EVENT.RESUME });
    assert.equal(afterResume.status, 'escalated', 'RESUME does not clear an escalation (only PARK is resumable)');
  });

  it('smoke-await enters awaiting-smoke-approval; a VERIFIED smoke-approve records the token and returns to running', () => {
    const { initLoopState, applyLoopEvent, LOOP_EVENT } = M();
    const s0 = initLoopState(SPEC(), io());
    const awaiting = applyLoopEvent(s0, { type: LOOP_EVENT.SMOKE_APPROVE, token: 'x', verified: true });
    // Guard: an approve while NOT awaiting is refused (state unchanged).
    assert.equal(awaiting.status, 'running', 'approve while running is a no-op (still running)');
    assert.ok(!awaiting.smokeApproval, 'no approval recorded when not awaiting');

    const waiting = applyLoopEvent(s0, { type: LOOP_EVENT.SMOKE_AWAIT });
    assert.equal(waiting.status, 'awaiting-smoke-approval');
    // The caller stamps the verify result on the event (verified === true).
    const approved = applyLoopEvent(waiting, { type: LOOP_EVENT.SMOKE_APPROVE, token: 'smoke-tok-1', verified: true });
    assert.equal(approved.status, 'running', 'a VERIFIED approval moves back to running');
    assert.ok(approved.smokeApproval, 'the approval is recorded in state');
    assert.equal(approved.smokeApproval.token, 'smoke-tok-1');
  });

  it('a STALE/unverified smoke-approve does NOT return to running (guarded transition — finding 2)', () => {
    const { initLoopState, applyLoopEvent, LOOP_EVENT } = M();
    const s0 = initLoopState(SPEC(), io());
    const waiting = applyLoopEvent(s0, { type: LOOP_EVENT.SMOKE_AWAIT });
    // verified:false is the caller's verifySmokeToken having found drift.
    const rejected = applyLoopEvent(waiting, { type: LOOP_EVENT.SMOKE_APPROVE, token: 'stale', verified: false });
    assert.notEqual(rejected.status, 'running', 'a drifted token must never resume the run');
    assert.ok(['awaiting-smoke-approval', 'parked'].includes(rejected.status), `stale approval refuses or parks; got ${rejected.status}`);
  });

  it('a smoke-approve with NO verified field is NOT an approval — missing != approved (iter-2 finding 1)', () => {
    const { initLoopState, applyLoopEvent, LOOP_EVENT } = M();
    const s0 = initLoopState(SPEC(), io());
    // Outside the awaiting state it is a no-op (consistent with the guard pin above):
    // the run stays running and nothing is recorded.
    const notAwaiting = applyLoopEvent(s0, { type: LOOP_EVENT.SMOKE_APPROVE, token: 'tok' }); // no `verified`
    assert.equal(notAwaiting.status, 'running', 'approve outside awaiting is a no-op — still running');
    assert.ok(!notAwaiting.smokeApproval, 'no approval recorded outside the awaiting state');

    // While awaiting, a missing verified field is treated as unverified (not approved):
    // it must NOT resume, mirroring the stale-token expectations.
    const inAwait = applyLoopEvent(applyLoopEvent(s0, { type: LOOP_EVENT.SMOKE_AWAIT }), { type: LOOP_EVENT.SMOKE_APPROVE, token: 'tok' });
    assert.notEqual(inAwait.status, 'running', 'while awaiting, a missing verified field is treated as unverified, not approved');
    assert.ok(['awaiting-smoke-approval', 'parked'].includes(inAwait.status), `unverified approval refuses or parks; got ${inAwait.status}`);
    assert.ok(!inAwait.smokeApproval, 'no accepted approval is recorded without an explicit verified:true');
  });

  it('is PURE — it does not mutate the input state', () => {
    const { initLoopState, applyLoopEvent, LOOP_EVENT } = M();
    const s0 = initLoopState(SPEC(), io());
    const snapshot = structuredClone(s0);
    applyLoopEvent(s0, { type: LOOP_EVENT.GATE_ITERATION, gate: 'gate-1', verdict: 'BLOCKED' });
    assert.deepEqual(s0, snapshot, 'the reducer returns a new state and never mutates its input');
  });
});

// ===========================================================================
describe('loadLoopState — snapshot + journal replay reproduces the in-memory sequence', () => {
  it('write base snapshot + append events, then reload == the folded in-memory state', async () => {
    const { initLoopState, applyLoopEvent, writeLoopState, appendLoopEvent, loadLoopState, LOOP_EVENT } = M();
    const spec = SPEC();
    const events = [
      { type: LOOP_EVENT.PHASE_ADVANCE },
      { type: LOOP_EVENT.GATE_ITERATION, gate: 'gate-1', verdict: 'APPROVED' },
      { type: LOOP_EVENT.PHASE_ADVANCE },
    ];

    const setup = io();
    const base = initLoopState(spec, setup);
    await writeLoopState('/repo', base, setup);
    for (const e of events) await appendLoopEvent('/repo', e, setup);

    const reloaded = (await loadLoopState('/repo', setup)).state;
    const inMemory = fold(applyLoopEvent, base, events);

    assert.equal(reloaded.status, inMemory.status, 'status matches the in-memory fold');
    assert.equal(reloaded.phaseIndex, inMemory.phaseIndex, 'phase index matches');
    assert.deepEqual(reloaded.iterations, inMemory.iterations, 'gate counters match');
  });

  it('tolerates a torn final journal line (crash mid-append) without throwing', async () => {
    const { initLoopState, writeLoopState, appendLoopEvent, loadLoopState, loopPaths, LOOP_EVENT } = M();
    const setup = io();
    const base = initLoopState(SPEC(), setup);
    await writeLoopState('/repo', base, setup);
    await appendLoopEvent('/repo', { type: LOOP_EVENT.GATE_ITERATION, gate: 'gate-1', verdict: 'APPROVED' }, setup);
    // Simulate a crash mid-append: a truncated trailing line.
    const p = loopPaths('/repo');
    setup.fs.appendFileSync(p.journal, '{"type":"gate-iter'); // torn JSON, no newline

    let res;
    assert.doesNotThrow(() => { res = undefined; });
    res = await loadLoopState('/repo', setup);
    assert.equal(res.state.iterations['gate-1'], 1, 'the one complete event still applies; the torn tail is ignored');
  });

  it('COMPLETED-WORK IDEMPOTENCY: replaying the same gate-iteration event does NOT double-increment', async () => {
    const { initLoopState, writeLoopState, loadLoopState, loopPaths } = M();
    const setup = io();
    const base = initLoopState(SPEC(), setup);
    await writeLoopState('/repo', base, setup); // snapshot journalSeq 0
    // Two journal lines carrying the SAME seq/dedupeKey — a duplicate replay of one
    // completed iteration (supervisor-death recovery must not re-run it).
    const p = loopPaths('/repo');
    const dup = { seq: 1, ts: '2026-07-19T00:00:01.000Z', type: 'gate-iteration', gate: 'gate-1', verdict: 'APPROVED', dedupeKey: 'k1' };
    setup.fs.appendFileSync(p.journal, JSON.stringify(dup) + '\n' + JSON.stringify(dup) + '\n');

    const reloaded = (await loadLoopState('/repo', setup)).state;
    assert.equal(reloaded.iterations['gate-1'], 1, 'the completed iteration is applied exactly once on replay (seq-skip dedup)');
  });
});

// ===========================================================================
describe('loop state — journal/atomic write idioms (finding 6)', () => {
  it('appendLoopEvent returns monotonically allocated seqs across calls', async () => {
    const { initLoopState, writeLoopState, appendLoopEvent, LOOP_EVENT } = M();
    const setup = io();
    await writeLoopState('/repo', initLoopState(SPEC(), setup), setup);
    const s1 = await appendLoopEvent('/repo', { type: LOOP_EVENT.PHASE_ADVANCE }, setup);
    const s2 = await appendLoopEvent('/repo', { type: LOOP_EVENT.GATE_ITERATION, gate: 'gate-1', verdict: 'APPROVED' }, setup);
    const s3 = await appendLoopEvent('/repo', { type: LOOP_EVENT.PHASE_ADVANCE }, setup);
    assert.ok(typeof s1 === 'number' && typeof s2 === 'number' && typeof s3 === 'number', 'each append returns a numeric seq');
    assert.ok(s1 < s2 && s2 < s3, `seqs are monotonically increasing; got ${s1}, ${s2}, ${s3}`);
  });

  it('the returned seqs are the seqs actually PERSISTED to journal.ndjson (iter-2 finding 2)', async () => {
    const { readAllTolerant } = await import('../../core/src/util/jsonl.mjs');
    const { initLoopState, writeLoopState, appendLoopEvent, loopPaths, LOOP_EVENT } = M();
    const setup = io();
    await writeLoopState('/repo', initLoopState(SPEC(), setup), setup);
    const returned = [
      await appendLoopEvent('/repo', { type: LOOP_EVENT.PHASE_ADVANCE }, setup),
      await appendLoopEvent('/repo', { type: LOOP_EVENT.GATE_ITERATION, gate: 'gate-1', verdict: 'APPROVED' }, setup),
    ];
    const { entries } = readAllTolerant(setup.fs, loopPaths('/repo').journal);
    assert.deepEqual(entries.map((/** @type {any} */ e) => e.seq), returned, 'each appended entry is stamped with the seq the call returned');
  });

  it('allocation CONTINUES from the current max over a pre-existing snapshot + journal (iter-2 finding 2)', async () => {
    const { readAllTolerant } = await import('../../core/src/util/jsonl.mjs');
    const { initLoopState, appendLoopEvent, loopPaths, LOOP_EVENT } = M();
    const setup = io();
    const p = loopPaths('/repo');
    // Pre-existing state: snapshot journalSeq 5, journal tail already at seq 6,7.
    const base = { ...initLoopState(SPEC(), setup), journalSeq: 5 };
    setup.fs.mkdirSync(p.dir, { recursive: true });
    setup.fs.writeFileSync(p.state, JSON.stringify(base, null, 2) + '\n');
    setup.fs.writeFileSync(
      p.journal,
      JSON.stringify({ seq: 6, type: LOOP_EVENT.PHASE_ADVANCE, ts: '2026-07-19T00:00:00.000Z', dedupeKey: 'e6' }) + '\n' +
        JSON.stringify({ seq: 7, type: LOOP_EVENT.PHASE_ADVANCE, ts: '2026-07-19T00:00:00.000Z', dedupeKey: 'e7' }) + '\n',
    );

    const s1 = await appendLoopEvent('/repo', { type: LOOP_EVENT.PHASE_ADVANCE }, setup);
    const s2 = await appendLoopEvent('/repo', { type: LOOP_EVENT.PHASE_ADVANCE }, setup);
    assert.deepEqual([s1, s2], [8, 9], 'allocation continues from max(snapshot.journalSeq, journal tail) = 7 → 8, 9');
    const { entries } = readAllTolerant(setup.fs, p.journal);
    assert.deepEqual(entries.map((/** @type {any} */ e) => e.seq), [6, 7, 8, 9], 'the persisted journal carries the continued seqs');
  });

  it('state.json first appears via renameSync from a tmp sibling under .handoff/loop (atomic write)', async () => {
    const { initLoopState, writeLoopState, loopPaths } = M();
    const setup = io();
    const target = loopPaths('/repo').state;
    await writeLoopState('/repo', initLoopState(SPEC(), setup), setup);

    // A tmp sibling must have existed mid-write (mirror fsx.test.mjs).
    const isTmp = (/** @type {string} */ p) => /\.tmp\./.test(p) && p.startsWith('/repo/.handoff/loop');
    const sawTmp = setup.fs.__history.some((/** @type {any} */ h) => Object.keys(h.files).some(isTmp));
    assert.ok(sawTmp, 'a *.tmp.* sibling existed in an intermediate state');

    // The target's FIRST appearance in history must be a rename, never a direct write.
    const firstAppearance = setup.fs.__history.find((/** @type {any} */ h) => target in h.files);
    assert.ok(firstAppearance, 'state.json appeared in history');
    assert.equal(firstAppearance.op, 'renameSync', 'state.json is published by rename, not a partial direct write');
  });
});

// ===========================================================================
describe('loop state writes are confined to .handoff/loop (finding 8)', () => {
  it('a persisted transition writes NOTHING outside <root>/.handoff/loop', async () => {
    const { initLoopState, writeLoopState, appendLoopEvent, LOOP_EVENT } = M();
    const setup = io();
    const base = initLoopState(SPEC(), setup);
    await writeLoopState('/repo', base, setup);
    await appendLoopEvent('/repo', { type: LOOP_EVENT.PHASE_ADVANCE }, setup);

    const escaped = setup.fs.__history
      .flatMap((/** @type {any} */ h) => h.paths.map(String))
      .filter((/** @type {string} */ p) => !p.startsWith('/repo/.handoff/loop'));
    assert.deepEqual(escaped, [], `every write stays under .handoff/loop; escaped: ${JSON.stringify(escaped)}`);
  });
});
