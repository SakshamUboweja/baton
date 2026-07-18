import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { cmdCheckpoint } from '../../core/src/commands/checkpoint.mjs';
import { bundlePaths } from '../../core/src/bundle/store.mjs';
import { readAllTolerant } from '../../core/src/util/jsonl.mjs';

// ---------------------------------------------------------------------------
// RED — `baton checkpoint --session <hint>` (subtask l1-checkpoint-session).
//
// Source of truth: docs/plans/2026-07-18-goal-loop-tasks.md subtask 2
//   (`checkpoint --session <hint>` flag: supervisor-owned stable session
//   identity) and docs/plans/2026-07-18-goal-loop-worktree-pipeline.md
//   §"Root + ownership discipline".
//
// The loop supervisor must checkpoint under its OWN stable session identity
// (`--session loop-<runId>`) regardless of what the piped hook payload carries,
// so its checkpoints land in ITS bundle and a concurrent child's payload
// session id can never masquerade as, or collide with, the supervisor owner.
//
// CONTRACT (pinned here):
//   S1. STRICT SPEC. `--session <hint>` is a KNOWN string flag: `--session abc`
//       parses and composes with the existing flags; a stray positional or an
//       unknown flag alongside it still exits 2 (unchanged strict parsing).
//   S2. NO SILENT FALLBACK. `--session ''` (empty value) is a usage error
//       (exit 2) whose message NAMES the flag and states it must be non-empty —
//       a supervisor bug that passes an empty hint must NOT silently fall back
//       to payload-derived identity. (Distinct from today's "unknown flag":
//       the message must mention "empty", never "unknown flag".)
//   S3. IDENTITY OVERRIDE. With `--session sup-1`, every checkpoint event's
//       effective session hint is `sup-1` (stable, unstable:false) — even when
//       the piped payload carries a DIFFERENT stable session_id. Asserted via
//       persisted state: origin.sessionHint and the journal writerId.
//   S4. OWNERSHIP SEMANTICS UNCHANGED, keyed on the effective (overridden) hint:
//       (a) seeding — first --session checkpoint into a fresh bundle records
//           that hint as the active owner;
//       (b) first-party — a second --session checkpoint with the same hint
//           lands (no foreign rejection);
//       (c) foreign — a --session X checkpoint into a bundle owned by stable
//           session Y is rejected exactly like today's foreign-stable case
//           (exit 0, --take-over named, memfs byte-identical); --take-over
//           still supersedes (fresh bundle owned by X);
//       (d) no --session — behaves exactly as today (regression negative).
//   S5. GUARD PRECEDENCE. BATON_SUPERVISED_CHILD set + --session → still the
//       silent no-op (the subtask-1 guard beats the flag).
//
// PROOF-OF-RED NOTE: `--session` is currently an UNKNOWN strict flag, so today
// cmdCheckpoint exits 2 ("unknown flag --session") before run(). The
// new-behavior tests below therefore assert exit 0 + the persisted override /
// ownership outcome, which fail correctly today. Assertions are crafted to
// distinguish "flag rejected as unknown" from the target behavior (S2 checks
// the message; S4c orders the exit-0 assertion first). The regression/guard
// tests (S1 garbled-still-2, S4d, S5) hold both today and after — labeled GREEN.
// ---------------------------------------------------------------------------

const T0 = '2026-07-11T00:00:00.000Z';
const paths = bundlePaths('/repo');

function mkBundle(overrides = {}) {
  return {
    schema: 'baton/bundle@1',
    bundleId: 'b_sess00000000000',
    generation: 1,
    createdAt: T0,
    updatedAt: T0,
    origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: null, unstable: false },
    task: { goal: 'g', constraints: [], acceptance: [] },
    plan: { steps: [] },
    decisions: [],
    files: { touched: [] },
    roles: { assignments: {} },
    git: null,
    handoff: { status: 'open', reason: null, reasonClass: null, toPlatformHint: null, finalizedAt: null, receive_log: [] },
    journalSeq: 0,
    compaction: { droppedDecisions: 0, note: null },
    dedupeRing: [],
    ...overrides,
  };
}

const snapText = (/** @type {any} */ b) => JSON.stringify(b, null, 2) + '\n';
// A single passthrough baton/event@1 event (mirrors tests/commands/checkpoint
// .test.mjs): its sessionHint/unstable ride verbatim through normalize.
const event = (/** @type {any} */ obj) => JSON.stringify({ schema: 'baton/event@1', ...obj });
const readSnapshot = (/** @type {any} */ io) => JSON.parse(io.files()[paths.snapshot]);
const journalEntries = (/** @type {any} */ io) => readAllTolerant(io.fs, paths.journal).entries;

// ===========================================================================
describe('checkpoint --session — strict spec (S1)', () => {
  it('RED: `--session abc` is accepted (exit 0, never "unknown flag")', async () => {
    const io = makeIo({
      stdin: event({ type: 'decision', payload: { summary: 's' }, sessionHint: 'abc', unstable: false }),
    });
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--session', 'abc'], io);
    assert.doesNotMatch(io.stderrText(), /unknown flag/i, '--session is a KNOWN flag, not rejected as unknown');
    assert.equal(code, 0, '`--session abc` parses and the checkpoint runs (exit 0)');
  });

  it('RED: `--session abc` composes with existing flags (--strict, valid seed → exit 0)', async () => {
    const io = makeIo({
      files: { [paths.snapshot]: snapText(mkBundle()) },
      stdin: event({ type: 'decision', payload: { summary: 's' }, sessionHint: 'abc', unstable: false }),
    });
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--session', 'abc', '--strict'], io);
    assert.equal(code, 0, '--session composes with --strict without a usage error');
    assert.doesNotMatch(io.stderrText(), /unknown flag/i);
  });

  it('GREEN guard: a stray positional alongside --session still exits 2', async () => {
    const io = makeIo({ stdin: '{}' });
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--session', 'abc', 'stray'], io);
    assert.equal(code, 2, 'a garbled invocation is a usage error regardless of --session');
  });

  it('GREEN guard: an unknown flag alongside --session still exits 2', async () => {
    const io = makeIo({ stdin: '{}' });
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--session', 'abc', '--no-such-flag'], io);
    assert.equal(code, 2);
  });
});

// ===========================================================================
describe('checkpoint --session — empty value is a usage error, never a silent fallback (S2)', () => {
  it('RED: `--session ""` exits 2 with a message naming the flag as non-empty (not "unknown flag")', async () => {
    const io = makeIo({
      stdin: event({ type: 'decision', payload: { summary: 's' } }),
    });
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--session', ''], io);
    assert.equal(code, 2, 'an empty --session is a usage error');
    assert.match(io.stderrText(), /--session/, 'the error names the flag');
    // The security point: it must be an EMPTY-VALUE rejection, not the current
    // "unknown flag" — a supervisor must never silently fall back to payload id.
    assert.match(io.stderrText(), /empty/i, 'the error states --session must be non-empty');
    assert.doesNotMatch(io.stderrText(), /unknown flag/i, 'not the generic unknown-flag path');
  });
});

// ===========================================================================
describe('checkpoint --session — identity override (S3)', () => {
  it('RED: --session sup-1 overrides a DIFFERENT payload session id in the persisted owner + writerId', async () => {
    // Fresh bundle; the piped event claims a stable id "payload-sess".
    const io = makeIo({
      stdin: event({ type: 'decision', payload: { summary: 'override-me' }, sessionHint: 'payload-sess', unstable: false }),
    });
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--session', 'sup-1'], io);
    assert.equal(code, 0);

    const snap = readSnapshot(io);
    assert.equal(snap.origin.sessionHint, 'sup-1', 'the supervisor identity, not the payload id, becomes the owner');
    assert.equal(snap.origin.unstable, false, 'a --session hint is a STABLE owner');

    const entries = journalEntries(io);
    const decision = entries.find((/** @type {any} */ e) => e.type === 'decision');
    assert.ok(decision, 'the decision landed in the journal');
    assert.match(String(decision.writerId), /sup-1/, 'the writerId records the supervisor identity');
    for (const e of entries) {
      assert.doesNotMatch(String(e.writerId ?? ''), /payload-sess/, 'the payload session id never appears as an owner/writer');
    }
  });

  it('RED: --session overrides EVERY event in a multi-event wrapper (not just events[0])', async () => {
    // Verifier iter-1 finding 1: a single-event test could pass an events[0]-only
    // override. Two events with two DIFFERENT payload session ids under one
    // --session must ALL be re-stamped to the supervisor identity.
    const seed = mkBundle({ origin: { platform: 'claude-code', model: 'm', sessionHint: 'sup-1', unstable: false } });
    const io = makeIo({
      files: { [paths.snapshot]: snapText(seed) },
      stdin: JSON.stringify({
        schema: 'baton/event@1',
        events: [
          { type: 'decision', payload: { summary: 'first' }, sessionHint: 'pay-a', unstable: false },
          { type: 'decision', payload: { summary: 'second' }, sessionHint: 'pay-b', unstable: false },
        ],
      }),
    });
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--session', 'sup-1'], io);
    assert.equal(code, 0);

    const entries = journalEntries(io).filter((/** @type {any} */ e) => e.type === 'decision');
    assert.equal(entries.length, 2, 'both events were journaled');
    for (const e of entries) {
      assert.equal(e.sessionHint, 'sup-1', 'EVERY journaled event carries the supervisor hint');
      assert.equal(e.unstable, false, 'EVERY overridden event is stable');
      assert.match(String(e.writerId), /sup-1/, 'EVERY writerId records the supervisor identity');
    }
    // Neither payload id may survive ANYWHERE in the journal (events[1] included).
    assert.doesNotMatch(JSON.stringify(journalEntries(io)), /pay-a|pay-b/, 'no payload session id appears in the journal');
  });
});

// ===========================================================================
describe('checkpoint --session — ownership semantics keyed on the overridden hint (S4)', () => {
  it('RED (a) seeding: first --session checkpoint into a fresh bundle records that hint as owner', async () => {
    // The passthrough event carries NO session hint, so WITHOUT --session there
    // would be no stable owner to adopt — --session supplies the stable owner.
    const io = makeIo({
      stdin: event({ type: 'decision', payload: { summary: 'seed-me' } }),
    });
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--session', 'loop-42'], io);
    assert.equal(code, 0);
    const snap = readSnapshot(io);
    assert.equal(snap.origin.sessionHint, 'loop-42', 'the fresh bundle is owned by the supervisor session');
    assert.equal(snap.origin.unstable, false);
  });

  it('RED (b) first-party: a second --session checkpoint with the same hint lands (no foreign rejection)', async () => {
    const seed = mkBundle({ origin: { platform: 'claude-code', model: 'm', sessionHint: 'loop-42', unstable: false } });
    const io = makeIo({
      files: { [paths.snapshot]: snapText(seed) },
      stdin: event({ type: 'decision', payload: { summary: 'second-checkpoint' }, sessionHint: 'ignored', unstable: false }),
    });
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--session', 'loop-42'], io);
    assert.equal(code, 0);
    assert.doesNotMatch(io.stderrText(), /--take-over/, 'a same-session checkpoint is NOT foreign');
    assert.ok(readSnapshot(io).decisions.some((/** @type {any} */ d) => d.summary === 'second-checkpoint'), 'the decision is applied to the owned bundle');
  });

  it('RED (c) foreign: --session X into a bundle owned by stable Y is rejected like any foreign session', async () => {
    const seed = mkBundle({ origin: { platform: 'claude-code', model: 'm', sessionHint: 'sess-Y', unstable: false } });
    const io = makeIo({
      files: { [paths.snapshot]: snapText(seed) },
      // Payload claims the OWNER's id (sess-Y) — the override to sess-X is what
      // makes this checkpoint foreign, proving ownership keys on --session.
      stdin: event({ type: 'decision', payload: { summary: 'from-supervisor-X' }, sessionHint: 'sess-Y', unstable: false }),
    });
    const before = io.files();
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--session', 'sess-X'], io);
    assert.equal(code, 0, 'foreign-session rejection is still exit 0 (hook safety)');
    assert.match(io.stderrText(), /--take-over/, 'the warning names the --take-over escape hatch');
    assert.deepEqual(io.files(), before, 'a rejected foreign --session checkpoint leaves the memfs byte-identical');
  });

  it('RED (c) --take-over supersedes: --session X --take-over archives + starts a fresh bundle owned by X', async () => {
    // Verifier iter-1 finding 2: mirror the non-flag takeover test
    // (tests/commands/checkpoint.test.mjs:291) — an implementation that merely
    // mutated the owner to sess-X WITHOUT rotating would still pass an
    // origin-only check, so pin the full takeover shape on the flag path.
    const seed = mkBundle({
      origin: { platform: 'claude-code', model: 'm', sessionHint: 'sess-Y', unstable: false },
      decisions: [{ seq: 1, ts: T0, summary: 'OLD-DECISION' }],
      journalSeq: 1,
    });
    const io = makeIo({
      files: {
        [paths.snapshot]: snapText(seed),
        [paths.journal]: JSON.stringify({ seq: 1, ts: T0, type: 'decision', dedupeKey: 'k1', payload: { summary: 'OLD-DECISION' } }) + '\n',
      },
      stdin: event({ type: 'decision', payload: { summary: 'takeover-by-X' }, sessionHint: 'sess-Y', unstable: false }),
    });
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--session', 'sess-X', '--take-over'], io);
    assert.equal(code, 0);

    // (a) the prior bundle is archived as a takeover rotation
    const historyNames = io.fs.readdirSync(paths.historyDir);
    assert.ok(historyNames.some((/** @type {string} */ n) => /\.takeover\.json$/.test(n)), 'the prior bundle is archived as a .takeover.json rotation (fresh start, not an in-place owner swap)');

    const snap = readSnapshot(io);
    assert.equal(snap.origin.sessionHint, 'sess-X', 'the fresh bundle is owned by the taking-over supervisor session');
    // (b) the new decision landed; (c) the old decision is gone
    assert.ok(snap.decisions.some((/** @type {any} */ d) => d.summary === 'takeover-by-X'), 'the new event applies to the fresh bundle');
    assert.ok(!snap.decisions.some((/** @type {any} */ d) => d.summary === 'OLD-DECISION'), 'the fresh bundle does NOT inherit the archived owner\'s decisions');

    // (d) the takeover event's journal identity uses the FLAG hint, not the payload id
    const newEntry = journalEntries(io).find((/** @type {any} */ e) => e.type === 'decision' && e.payload?.summary === 'takeover-by-X');
    assert.ok(newEntry, 'the takeover decision is journaled');
    assert.match(String(newEntry.writerId), /sess-X/, 'the takeover journal identity is the --session flag hint');
    assert.doesNotMatch(String(newEntry.writerId), /sess-Y/, 'never the archived owner / payload id');
  });

  it('GREEN regression: WITHOUT --session, ownership behaves exactly as today', async () => {
    const seed = mkBundle({ origin: { platform: 'claude-code', model: 'm', sessionHint: 'sess-A', unstable: false } });
    const io = makeIo({
      files: { [paths.snapshot]: snapText(seed) },
      stdin: event({ type: 'decision', payload: { summary: 'same-owner' }, sessionHint: 'sess-A', unstable: false }),
    });
    const code = await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.equal(code, 0);
    assert.ok(readSnapshot(io).decisions.some((/** @type {any} */ d) => d.summary === 'same-owner'), 'a same-owner checkpoint still lands with no --session');
  });
});

// ===========================================================================
describe('checkpoint --session — guard precedence (S5)', () => {
  it('GREEN guard: BATON_SUPERVISED_CHILD + --session is still the silent no-op (guard beats the flag)', async () => {
    const io = makeIo({
      env: { BATON_SUPERVISED_CHILD: '1' },
      files: { [paths.snapshot]: snapText(mkBundle()) },
      stdin: event({ type: 'decision', payload: { summary: 's' }, sessionHint: 'sup-1', unstable: false }),
    });
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--session', 'sup-1'], io);
    assert.equal(code, 0, 'supervised child exits 0');
    assert.equal(io.stdoutText(), '', 'no stdout under the guard');
    assert.equal(io.stderrText(), '', 'no stderr under the guard (the unknown/known status of --session never matters)');
    assert.equal(io.fs.__history.length, 0, 'the guard writes nothing, --session notwithstanding');
  });
});
