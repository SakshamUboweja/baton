import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { cmdCheckpoint } from '../../core/src/commands/checkpoint.mjs';
import { bundlePaths } from '../../core/src/bundle/store.mjs';
import { readAllTolerant } from '../../core/src/util/jsonl.mjs';

// ---------------------------------------------------------------------------
// Command-level contract for core/src/commands/checkpoint.mjs. Called by DIRECT
// import over fakeio, mirroring cmdDetect/cmdRemap: cmdCheckpoint(args, io) ->
// exit code (this file `await`s it, so it is agnostic to sync/async; a checkpoint
// that refreshes git is async). stdin arrives as the STRING io.stdin.
//
// Source of truth: docs/design/core.md §CLI contract ("Checkpoint soft-fails to
// exit 0 in hook contexts (--strict opts out)"); plan §Checkpoint engine
// ("adapters send pre-normalized baton/event@1 on stdin … journal append always,
// snapshot rewrite throttled (>=10 events / 30 s / important event types) …
// Hook-safety rule: exit 0 on all soft failures"); §Concurrency ("a checkpoint
// whose sessionHint/origin doesn't match the active bundle is rejected with an
// actionable warning; --take-over supersedes: archives the current bundle to
// history/ and starts fresh"); §normalize (checkpoint runs stdin through
// normalizeHookPayload — baton/event@1 passes through verbatim).
//
// PINS:
//   1. INPUT: stdin is a JSON payload; checkpoint parses it and runs it through
//      normalize (baton/event@1 -> passthrough). Each normalized event is stamped
//      (ts=io.now(), a non-empty string dedupeKey, an allocated numeric seq) and
//      appended to the journal — the stamps are asserted on the appended entry
//      (verifier fold F6: dedupe idempotency needs the key actually persisted).
//   2. IMPORTANT vs ROUTINE (throttle). Journal append ALWAYS. A snapshot rewrite
//      (bundle.json + HANDOFF.md re-rendered) happens when the event type is
//      IMPORTANT, OR >30s elapsed since the snapshot's updatedAt, OR >=10 events
//      have accreted since the last snapshot write (all three triggers tested;
//      F6 added the count trigger). A 'note' is ROUTINE; a 'decision' is
//      IMPORTANT. When throttled, the journal grows but bundle.json is
//      byte-unchanged.
//   3. MISSING BUNDLE: no .handoff -> checkpoint SEEDS a fresh bundle, applies the
//      event, and warns; exit 0.
//   4. HOOK SAFETY: unparseable stdin -> exit 0 + a warning; --strict -> exit 1.
//   5. FOREIGN SESSION (semantic isolation, plan §Concurrency):
//      (a) an incoming STABLE sessionHint that differs from the active bundle's
//          stable origin.sessionHint is REJECTED — exit STILL 0 (hook safety), a
//          warning NAMES --take-over, and the ENTIRE memfs is byte-identical
//          (F4: nothing may land in journal.ndjson either — a journaled foreign
//          event would replay into the bundle later).
//      (b) an origin PLATFORM mismatch (--platform differs from the bundle's
//          origin.platform, stable hint matching) is rejected the same way (F5 —
//          the plan gates on sessionHint/ORIGIN).
//      (c) an UNSTABLE incoming hint NEVER triggers rejection on its own (plan
//          §sessionHint derivation; F5): the event is applied normally, with a
//          warning only.
//   6. --take-over: archives the active bundle via rotateJournal kind 'takeover'
//      and starts a FRESH bundle owned by the incoming session (origin.platform =
//      --platform, origin.sessionHint = incoming hint), then applies the event.
//
// Session facts ride on the (passthrough) event's sessionHint/unstable fields.
// Seeds whose origin.sessionHint is null never trigger the foreign check (nothing
// stable to compare), keeping the throttle/seed tests free of session noise.
// ---------------------------------------------------------------------------

const T0 = '2026-07-11T00:00:00.000Z';
const paths = bundlePaths('/repo');

function mkBundle(overrides = {}) {
  return {
    schema: 'baton/bundle@1',
    bundleId: 'b_ckpt0000000000',
    generation: 1,
    createdAt: T0,
    updatedAt: T0,
    origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: null, unstable: false },
    task: { goal: 'Build the checkpoint cmd', constraints: [], acceptance: [] },
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

const snapText = (b) => JSON.stringify(b, null, 2) + '\n';
const event = (obj) => JSON.stringify({ schema: 'baton/event@1', ...obj });
const journalEntries = (io) => readAllTolerant(io.fs, paths.journal).entries;
const readSnapshot = (io) => JSON.parse(io.files()[paths.snapshot]);

// ===========================================================================
describe('checkpoint — baton/event@1 on stdin: journal append + snapshot for important types', () => {
  it('an important event (decision) is appended AND applied to the rewritten snapshot; exit 0', async () => {
    const io = makeIo({
      files: { [paths.snapshot]: snapText(mkBundle()) },
      stdin: event({ type: 'decision', payload: { summary: 'Chose tmp+rename' } }),
    });

    const code = await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.equal(code, 0);

    const entries = journalEntries(io);
    assert.equal(entries.length, 1, 'the event is appended to the journal');
    assert.equal(entries[0].type, 'decision');
    assert.ok(typeof entries[0].seq === 'number', '(F6) the appended entry is stamped with an allocated numeric seq');
    assert.ok(
      typeof entries[0].dedupeKey === 'string' && entries[0].dedupeKey.length > 0,
      '(F6) the appended entry carries a persisted dedupeKey — the idempotency handle',
    );
    assert.ok(
      typeof entries[0].writerId === 'string' && entries[0].writerId.includes('claude-code'),
      '(iter-2) the appended entry carries a writerId naming the writing platform — the concurrency audit handle',
    );

    const snap = readSnapshot(io);
    assert.ok(
      snap.decisions.some((d) => d.summary === 'Chose tmp+rename'),
      'an important event forces a snapshot rewrite with the event applied',
    );
  });
});

// ===========================================================================
describe('checkpoint — snapshot throttling', () => {
  it('a ROUTINE note within 30s appends the journal WITHOUT rewriting the snapshot', async () => {
    const io = makeIo({
      files: { [paths.snapshot]: snapText(mkBundle({ updatedAt: T0, journalSeq: 0 })) },
      stdin: event({ type: 'note', payload: { text: 'ROUTINE-NOTE' } }),
    });
    io.setNow('2026-07-11T00:00:10.000Z'); // +10s, well within the 30s window
    const snapBefore = io.files()[paths.snapshot];

    const code = await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.equal(code, 0);

    assert.equal(io.files()[paths.snapshot], snapBefore, 'the snapshot is NOT rewritten within the throttle window');
    assert.equal(journalEntries(io).length, 1, 'but the journal still grows (append always)');
    assert.ok(!readSnapshot(io).decisions.some((d) => d.summary === 'ROUTINE-NOTE'), 'the routine note is not yet folded into the snapshot');
  });

  it('an important event bypasses the throttle window and rewrites the snapshot', async () => {
    const io = makeIo({
      files: { [paths.snapshot]: snapText(mkBundle({ updatedAt: T0 })) },
      stdin: event({ type: 'decision', payload: { summary: 'IMPORTANT-NOW' } }),
    });
    io.setNow('2026-07-11T00:00:10.000Z'); // +10s: within the window, but the type is important
    const snapBefore = io.files()[paths.snapshot];

    await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.notEqual(io.files()[paths.snapshot], snapBefore, 'an important event rewrites even inside the throttle window');
    assert.ok(readSnapshot(io).decisions.some((d) => d.summary === 'IMPORTANT-NOW'));
  });

  it('a routine note AFTER 30s rewrites the snapshot (time-based throttle release)', async () => {
    const io = makeIo({
      files: { [paths.snapshot]: snapText(mkBundle({ updatedAt: T0 })) },
      stdin: event({ type: 'note', payload: { text: 'LATE-NOTE' } }),
    });
    io.setNow('2026-07-11T00:00:40.000Z'); // +40s: past the 30s window
    const snapBefore = io.files()[paths.snapshot];

    await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.notEqual(io.files()[paths.snapshot], snapBefore, 'a routine note past 30s triggers a rewrite');
  });

  it('(F6) the 10th accreted event forces a snapshot rewrite even within 30s (count-based throttle release)', async () => {
    // 9 routine notes already accreted in the journal past the snapshot boundary
    // (snapshot journalSeq 0). The 10th routine note arrives 10s later — inside
    // the 30s window, routine type — but the >=10-events trigger fires.
    const nine =
      Array.from({ length: 9 }, (_v, i) =>
        JSON.stringify({ seq: i + 1, ts: T0, type: 'note', dedupeKey: `acc-${i + 1}`, source: 'stop', payload: { text: `ROUTINE-${i + 1}` } }),
      ).join('\n') + '\n';
    const io = makeIo({
      files: {
        [paths.snapshot]: snapText(mkBundle({ updatedAt: T0, journalSeq: 0 })),
        [paths.journal]: nine,
      },
      stdin: event({ type: 'note', payload: { text: 'THE-TENTH' } }),
    });
    io.setNow('2026-07-11T00:00:10.000Z'); // +10s: inside the 30s window
    const snapBefore = io.files()[paths.snapshot];

    const code = await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.equal(code, 0);
    assert.notEqual(io.files()[paths.snapshot], snapBefore, '>=10 accreted events force a rewrite despite the 30s window and routine type');
    const snap = readSnapshot(io);
    assert.equal(snap.journalSeq, 10, 'the rewritten snapshot folds all ten events');
    assert.ok(snap.decisions.some((d) => d.summary === 'THE-TENTH'), 'the triggering event is folded in');
    assert.ok(snap.decisions.some((d) => d.summary === 'ROUTINE-1'), 'the earlier accreted events are folded in too');
  });
});

// ===========================================================================
describe('checkpoint — missing bundle auto-seeds', () => {
  it('with no .handoff, seeds a fresh bundle, applies the event, warns, and exits 0', async () => {
    const io = makeIo({ stdin: event({ type: 'decision', payload: { summary: 'first ever' } }) });

    const code = await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.equal(code, 0, 'seeding is a soft, hook-safe path (exit 0)');

    const files = io.files();
    assert.ok(files[paths.snapshot], 'a bundle.json seed was created');
    const snap = JSON.parse(files[paths.snapshot]);
    assert.equal(snap.schema, 'baton/bundle@1');
    assert.ok(snap.decisions.some((d) => d.summary === 'first ever'), 'the event is applied to the fresh seed');
    assert.match(io.stderrText(), /seed|created|new bundle|auto/i, 'a warning notes the auto-seed');
  });
});

// ===========================================================================
describe('checkpoint — hook safety on bad input', () => {
  it('unparseable stdin -> exit 0 with a warning (a checkpoint must never break the host)', async () => {
    const io = makeIo({ files: { [paths.snapshot]: snapText(mkBundle()) }, stdin: 'not json at all {' });
    const code = await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.equal(code, 0, 'a parse failure soft-fails to exit 0');
    assert.match(io.stderrText(), /pars|invalid|json|unread|could not/i, 'a warning explains the ignored input');
  });

  it('--strict turns the same parse failure into exit 1 (CI opt-out)', async () => {
    const io = makeIo({ files: { [paths.snapshot]: snapText(mkBundle()) }, stdin: 'not json at all {' });
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--strict'], io);
    assert.equal(code, 1, '--strict opts into a hard failure');
  });
});

// ===========================================================================
describe('checkpoint — foreign session isolation', () => {
  it('a foreign STABLE sessionHint is rejected: FULL memfs byte-identical, exit STILL 0, warning names --take-over', async () => {
    const seed = mkBundle({
      origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: 'sess-A', unstable: false },
      decisions: [{ seq: 1, ts: T0, summary: 'belongs-to-A' }],
      journalSeq: 1,
    });
    const io = makeIo({
      files: { [paths.snapshot]: snapText(seed) },
      stdin: event({ type: 'decision', payload: { summary: 'from-session-B' }, sessionHint: 'sess-B', unstable: false }),
    });
    const before = io.files();

    const code = await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.equal(code, 0, 'foreign-session rejection is STILL exit 0 for hook safety');
    assert.match(io.stderrText(), /--take-over/, 'the warning names the --take-over escape hatch');
    assert.match(io.stderrText(), /session|foreign|different|another/i, 'the warning explains it is a foreign session');

    // (F4) The WHOLE tree must be untouched — a rejected event that still lands
    // in journal.ndjson would replay into the bundle on a later load.
    assert.deepEqual(io.files(), before, 'a rejected foreign event leaves the entire memfs byte-identical (no journal append, no log entry)');
    assert.ok(!readSnapshot(io).decisions.some((d) => d.summary === 'from-session-B'), 'the foreign decision is not merged in');
  });

  it('(F5) an origin PLATFORM mismatch (matching stable hint) is rejected the same way: exit 0, --take-over named, memfs untouched', async () => {
    const seed = mkBundle({
      origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: 'sess-A', unstable: false },
    });
    const io = makeIo({
      files: { [paths.snapshot]: snapText(seed) },
      // Same stable session hint — but the checkpoint claims a different platform.
      stdin: event({ type: 'decision', payload: { summary: 'from-codex' }, sessionHint: 'sess-A', unstable: false }),
    });
    const before = io.files();

    const code = await cmdCheckpoint(['--platform', 'codex'], io);
    assert.equal(code, 0, 'origin-mismatch rejection is still exit 0 (hook safety)');
    assert.match(io.stderrText(), /--take-over/, 'the warning names --take-over');
    assert.deepEqual(io.files(), before, 'the mismatched-origin event mutates nothing anywhere');
    assert.ok(!readSnapshot(io).decisions.some((d) => d.summary === 'from-codex'));
  });

  it('(F5) an UNSTABLE foreign hint does NOT reject on its own: the event is applied, with a warning only', async () => {
    // Plan §sessionHint derivation: "unstable hints never trigger foreign-session
    // rejection on their own, only a warning".
    const seed = mkBundle({
      origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: 'sess-A', unstable: false },
    });
    const io = makeIo({
      files: { [paths.snapshot]: snapText(seed) },
      stdin: event({ type: 'decision', payload: { summary: 'from-unstable-hint' }, sessionHint: 'proc-generated-xyz', unstable: true }),
    });

    const code = await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.equal(code, 0);
    assert.ok(
      readSnapshot(io).decisions.some((d) => d.summary === 'from-unstable-hint'),
      'the unstable-hint event IS applied (important type -> snapshot rewrite)',
    );
    assert.equal(journalEntries(io).length, 1, 'the event is journaled normally');
    assert.match(io.stderrText(), /session|unstable/i, 'a warning is still surfaced');
  });

  it('--take-over archives the active bundle (rotateJournal takeover) and starts a fresh bundle for the new session', async () => {
    const seed = mkBundle({
      origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: 'sess-A', unstable: false },
      decisions: [{ seq: 1, ts: T0, summary: 'OLD-DECISION' }],
      journalSeq: 1,
    });
    const io = makeIo({
      files: {
        [paths.snapshot]: snapText(seed),
        [paths.journal]: JSON.stringify({ seq: 1, ts: T0, type: 'decision', dedupeKey: 'k1', payload: { summary: 'OLD-DECISION' } }) + '\n',
      },
      stdin: event({ type: 'decision', payload: { summary: 'from-session-B' }, sessionHint: 'sess-B', unstable: false }),
    });

    const code = await cmdCheckpoint(['--platform', 'codex', '--take-over'], io);
    assert.equal(code, 0);

    const historyNames = io.fs.readdirSync(paths.historyDir);
    assert.ok(historyNames.some((n) => /\.takeover\.json$/.test(n)), 'the prior bundle is archived as a takeover rotation');

    const snap = readSnapshot(io);
    assert.equal(snap.origin.sessionHint, 'sess-B', 'the fresh bundle is owned by the taking-over session');
    assert.equal(snap.origin.platform, 'codex', 'the fresh bundle adopts the taking-over platform');
    assert.ok(snap.decisions.some((d) => d.summary === 'from-session-B'), 'the new event applies to the fresh bundle');
    assert.ok(!snap.decisions.some((d) => d.summary === 'OLD-DECISION'), 'the fresh bundle does NOT inherit the archived session\'s decisions');
  });
});

describe('checkpoint — tolerant stdin shapes (live /baton:handoff failure)', () => {
  // Field finding: the handoff command says "send baton/event@1 events on
  // stdin" and a live model sent one event PER LINE (NDJSON). The old parser
  // rejected everything but a single JSON value, so the narrative checkpoint
  // silently failed. Accept the shapes a model plausibly produces: a single
  // {schema, events} object (canonical), a bare array of events, and NDJSON
  // where every line is an event object — anything else stays bad-stdin.
  it('NDJSON stdin (one event per line) journals every line', async () => {
    const io = makeIo({
      files: { [paths.snapshot]: snapText(mkBundle()) },
      stdin:
        JSON.stringify({ schema: 'baton/event@1', type: 'decision', payload: { summary: 'ndjson-line-1' } }) +
        '\n' +
        JSON.stringify({ type: 'decision', payload: { summary: 'ndjson-line-2' } }) +
        '\n',
    });
    const code = await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.equal(code, 0);
    const sums = journalEntries(io).map((e) => e.payload?.summary);
    assert.ok(sums.includes('ndjson-line-1') && sums.includes('ndjson-line-2'), `both NDJSON events journaled; got ${sums}`);
  });

  it('a bare JSON array of events journals every element', async () => {
    const io = makeIo({
      files: { [paths.snapshot]: snapText(mkBundle()) },
      stdin: JSON.stringify([
        { type: 'decision', payload: { summary: 'arr-1' } },
        { type: 'note', payload: { text: 'arr-2' } },
      ]),
    });
    const code = await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.equal(code, 0);
    const entries = journalEntries(io);
    assert.equal(entries.length, 2, 'both array elements journaled');
  });

  it('NDJSON with a non-event line is still bad-stdin (no partial application)', async () => {
    const io = makeIo({
      files: { [paths.snapshot]: snapText(mkBundle()) },
      stdin: JSON.stringify({ type: 'decision', payload: { summary: 'good' } }) + '\nnot json at all\n',
    });
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--strict'], io);
    assert.equal(code, 1, 'strict mode hard-fails');
    assert.equal(journalEntries(io).length, 0, 'nothing was journaled from the torn input');
  });

  it('an array with a non-event element is bad-stdin, not a partial apply', async () => {
    const io = makeIo({
      files: { [paths.snapshot]: snapText(mkBundle()) },
      stdin: JSON.stringify([{ type: 'decision', payload: { summary: 'good' } }, 'garbage-string']),
    });
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--strict'], io);
    assert.equal(code, 1);
    assert.equal(journalEntries(io).length, 0);
  });
});

describe('checkpoint — schema-miss and bare-event stdin (audit findings 2/13/17)', () => {
  // A close-miss of the documented wrapper must ERROR, not silently degrade to
  // a junk "hook unknown" note with ok:true — a model cannot self-correct from
  // a success envelope while its narrative was discarded.
  it('an events array with the schema key MISSING is bad-stdin, not a silent junk note', async () => {
    const io = makeIo({
      files: { [paths.snapshot]: snapText(mkBundle()) },
      stdin: JSON.stringify({ events: [{ type: 'decision', payload: { summary: 'lost-narrative' } }] }),
    });
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--strict'], io);
    assert.equal(code, 1, 'strict mode hard-fails');
    assert.equal(journalEntries(io).length, 0, 'nothing journaled');
    assert.match(io.stderrText(), /schema/i, 'the error names the schema field so the model can self-correct');
  });

  it('an events array with a WRONG schema string is bad-stdin too', async () => {
    const io = makeIo({
      files: { [paths.snapshot]: snapText(mkBundle()) },
      stdin: JSON.stringify({ schema: 'baton/events@1', events: [{ type: 'decision', payload: { summary: 'x' } }] }),
    });
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--strict'], io);
    assert.equal(code, 1);
    assert.equal(journalEntries(io).length, 0);
  });

  it('a single bare event object (no schema, not a hook payload) is accepted as that event', async () => {
    const io = makeIo({
      files: { [paths.snapshot]: snapText(mkBundle()) },
      stdin: JSON.stringify({ type: 'decision', payload: { summary: 'bare-event' } }),
    });
    const code = await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.equal(code, 0);
    const entries = journalEntries(io);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, 'decision');
    assert.equal(entries[0].payload.summary, 'bare-event');
  });

  it('a hook payload carrying a `type` field is NOT mistaken for a bare event', async () => {
    // hook_event_name marks it a raw harness payload; the extractor tier owns it.
    const io = makeIo({
      files: { [paths.snapshot]: snapText(mkBundle()) },
      stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 's9', type: 'weird-harness-field' }),
    });
    await cmdCheckpoint(['--platform', 'claude-code'], io);
    const entries = journalEntries(io);
    assert.equal(entries[0].type, 'note', 'extractor tier handles it (a Stop note), not the bare-event tier');
    assert.equal(entries[0].payload.trigger, 'Stop');
  });
});

describe('checkpoint — hint-less narrative cannot merge into a FOREIGN platform bundle (audit finding 1)', () => {
  const codexOwned = () =>
    mkBundle({ origin: { platform: 'codex', model: 'gpt-5.6-sol', sessionHint: 'codex-sess-1', unstable: false } });

  it('schema events without a session hint are REFUSED when the bundle is owned by another platform', async () => {
    const io = makeIo({
      files: { [paths.snapshot]: snapText(codexOwned()) },
      stdin: JSON.stringify({ schema: 'baton/event@1', events: [{ type: 'decision', payload: { summary: 'foreign-narrative' } }] }),
    });
    const code = await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.equal(code, 0, 'hook-safety: soft exit');
    assert.equal(journalEntries(io).length, 0, 'the foreign narrative must not merge into the codex-owned bundle');
    assert.match(io.stderrText(), /foreign|take-over/i, 'the refusal names the remedy');
  });

  it('the SAME platform without a hint still applies (only the platform mismatch is provable)', async () => {
    const io = makeIo({
      files: { [paths.snapshot]: snapText(codexOwned()) },
      stdin: JSON.stringify({ schema: 'baton/event@1', events: [{ type: 'decision', payload: { summary: 'same-platform' } }] }),
    });
    const code = await cmdCheckpoint(['--platform', 'codex'], io);
    assert.equal(code, 0);
    assert.equal(journalEntries(io).length, 1, 'same-platform hint-less narrative applies');
  });

  it('--take-over lets a foreign hint-less narrative archive and restart', async () => {
    const io = makeIo({
      files: { [paths.snapshot]: snapText(codexOwned()) },
      stdin: JSON.stringify({ schema: 'baton/event@1', events: [{ type: 'decision', payload: { summary: 'took-over' } }] }),
    });
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--take-over'], io);
    assert.equal(code, 0);
    const snap = readSnapshot(io);
    assert.equal(snap.origin.platform, 'claude-code', 'fresh bundle owned by the taking-over platform');
  });
});

describe('checkpoint — --trigger stamps the event identity (GUI-app canary fix)', () => {
  it('a raw cursor stop payload (no event field) + --trigger stop journals trigger=stop', async () => {
    // Cursor's stop payload names the event nowhere normalize can find it, so
    // without --trigger the note degraded to trigger "unknown" and doctor never
    // saw the canary. The hook command now declares the event explicitly.
    const io = makeIo({
      files: { [paths.snapshot]: snapText(mkBundle({ origin: { platform: 'cursor', model: 'composer', sessionHint: null, unstable: false } })) },
      stdin: JSON.stringify({ conversation_id: 'c1', workspace_roots: ['/repo'] }),
    });

    const code = await cmdCheckpoint(['--platform', 'cursor', '--trigger', 'stop'], io);
    assert.equal(code, 0);

    const note = journalEntries(io).find((e) => e.type === 'note');
    assert.ok(note, 'a note was journaled for the cursor stop hook');
    assert.equal(note.payload.trigger, 'stop', 'the note carries the explicit trigger, so doctor sees the stop canary');
    assert.equal(note.source, 'cursor');
  });

  it('without --trigger the same payload still degrades to unknown (guards the regression the flag fixes)', async () => {
    const io = makeIo({
      files: { [paths.snapshot]: snapText(mkBundle({ origin: { platform: 'cursor', model: 'composer', sessionHint: null, unstable: false } })) },
      stdin: JSON.stringify({ conversation_id: 'c1' }),
    });
    await cmdCheckpoint(['--platform', 'cursor'], io);
    const note = journalEntries(io).find((e) => e.type === 'note');
    assert.equal(note.payload.trigger, 'unknown');
  });
});
