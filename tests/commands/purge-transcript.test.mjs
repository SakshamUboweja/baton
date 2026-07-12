import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { cmdPurgeTranscript } from '../../core/src/commands/purge-transcript.mjs';
import { bundlePaths } from '../../core/src/bundle/store.mjs';

// ---------------------------------------------------------------------------
// Command-level contract for core/src/commands/purge-transcript.mjs. Direct
// import over fakeio: cmdPurgeTranscript(args, io) -> exit code (awaited; the
// journal rewrite runs under the repo lock and is sync, but the command is
// treated as possibly-async for parity with the other commands).
//
// TARGET MODULE: core/src/commands/purge-transcript.mjs (sole target — its
// absence is the only reason this file is RED). It reuses store/lock internals;
// this file imports ONLY the command plus bundlePaths (an implemented helper) to
// address the .handoff tree.
//
// Source of truth: plan §Transcript policy ("baton purge-transcript removes the
// [transcript] field from EVERY retained copy — active snapshot, .bak, journal
// (rewrite-and-rotate under lock), and all history/ freezes — with a test
// asserting planted secrets are absent from the entire .handoff/ tree
// afterward") + §Diagnostics logging ("inclusion in the whole-tree purge test");
// §rotation ("the same marker pattern governs ... interrupted purges (purge
// resumes from its marker until the whole tree is clean)").
//
// PINS (where the plan left the surface open — the implementer conforms):
//   P1. THE FIELD is the top-level bundle key `transcript` (docs/design/core.md
//       bundle-schema field list: "transcript field (opt-in, redacted)"). Purge
//       removes it from every JSON snapshot/freeze and scrubs any transcript-
//       bearing payload from journal / rotated-journal / log lines.
//   P2. WHOLE-TREE GUARANTEE. The planted secret lives ONLY inside transcript
//       fields, seeded across snapshot + .bak + journal + a history freeze + a
//       rotated history journal + a log line. After purge, NO file anywhere under
//       <root>/.handoff contains the secret (a recursive walk asserts absence).
//   P3. SURGICAL. Purge removes ONLY the transcript — the active snapshot keeps
//       its goal, decisions, handoff block, journalSeq, etc.; `transcript` is
//       gone; exit 0.
//   P4. MARKER-BASED RESUME. Purge is marker-guarded: during a fresh run a purge
//       marker (a file under .handoff whose name contains "purge" and "marker")
//       is written and later cleared (proven from the memfs mutation history). An
//       INTERRUPTED purge — a leftover marker plus a partially-scrubbed tree — is
//       resumed and finished on the next run: the whole tree ends clean and the
//       marker is cleared (asserted by OUTCOME, robust to the marker's exact
//       name/path).
//   P5. UNDER LOCK. A live foreign lock blocks the purge: it fails (exit 1) and
//       leaves the ENTIRE memfs byte-identical — io.files() deep-equal before/
//       after (verifier fold F7): under a foreign lock NOTHING may be written,
//       not even a marker.
//   P6. NO-OP. A tree with no transcript anywhere purges cleanly (exit 0) and
//       leaves the bundle byte-identical.
//   P7. PRESERVATION (verifier fold F8 — deletion is NOT purging). Every
//       retained copy SURVIVES the purge with its non-transcript content intact:
//       the .bak still parses with its bundleId/decisions; the history freeze
//       keeps its path, bundleId, and sealed handoff; every seeded journal EVENT
//       survives (matched by dedupeKey across the live journal and history
//       .ndjson files, tolerant to the plan's rewrite-AND-ROTATE wording moving
//       live entries into history/) with its non-transcript payload fields
//       preserved; the log entry keeps its ts/event metadata. Only transcript
//       fields disappear.
// ---------------------------------------------------------------------------

const ROOT = '/repo';
const paths = bundlePaths(ROOT);
const T0 = '2026-07-11T00:00:00.000Z';
const SECRET = 'sk-PLANTED-SECRET-ABC123XYZ';

function baseBundle(overrides = {}) {
  return {
    schema: 'baton/bundle@1',
    bundleId: 'b_purge000000000',
    generation: 1,
    createdAt: T0,
    updatedAt: T0,
    origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: null, unstable: false },
    task: { goal: 'Wire the purge command', constraints: [], acceptance: [] },
    plan: { steps: [] },
    decisions: [{ seq: 1, ts: T0, summary: 'keep-this-decision' }],
    files: { touched: [] },
    roles: { assignments: {} },
    git: null,
    handoff: { status: 'open', reason: null, reasonClass: null, toPlatformHint: null, finalizedAt: null, receive_log: [] },
    journalSeq: 2,
    compaction: { droppedDecisions: 0, note: null },
    dedupeRing: [],
    // The opt-in transcript field (P1), carrying the planted secret.
    transcript: { tail: [{ role: 'user', text: `my api key is ${SECRET} keep it safe` }], capturedAt: T0 },
    ...overrides,
  };
}

const snapText = (b) => JSON.stringify(b, null, 2) + '\n';

// A journal whose entries include a transcript-bearing payload carrying the secret.
const JOURNAL_WITH_SECRET =
  JSON.stringify({ seq: 1, ts: T0, type: 'note', dedupeKey: 'k1', source: 'stop', payload: { text: 'ok' } }) + '\n' +
  JSON.stringify({ seq: 2, ts: T0, type: 'note', dedupeKey: 'k2', source: 'precompact', payload: { text: 'boundary', transcript: { tail: [SECRET] } } }) + '\n';

// A history freeze (finalize) + its rotated journal, both carrying the secret.
const FREEZE_STEM = '2026-07-10T00-00-00-000Z.finalize';
const HISTORY_FREEZE = snapText(baseBundle({ bundleId: 'b_frozen00000000', handoff: { status: 'sealed', reason: 'x', reasonClass: null, toPlatformHint: null, finalizedAt: T0, receive_log: [] } }));
const HISTORY_JOURNAL = JSON.stringify({ seq: 2, ts: T0, type: 'note', dedupeKey: 'h1', source: 'precompact', payload: { transcript: { tail: [SECRET] } } }) + '\n';

// A diagnostics log line carrying the secret in a transcript field (defense in depth).
const LOG_LINE = JSON.stringify({ ts: T0, event: 'precompact', transcript: { tail: [SECRET] } }) + '\n';

function fullTree() {
  return {
    [paths.snapshot]: snapText(baseBundle()),
    [paths.bak]: snapText(baseBundle({ bundleId: 'b_bak0000000000' })),
    [paths.journal]: JOURNAL_WITH_SECRET,
    [`${paths.historyDir}/${FREEZE_STEM}.json`]: HISTORY_FREEZE,
    [`${paths.historyDir}/${FREEZE_STEM}.ndjson`]: HISTORY_JOURNAL,
    [`${paths.logDir}/2026-07-11.jsonl`]: LOG_LINE,
  };
}

/** Recursively collect every file's content under a memfs directory. */
function allFiles(io, dir) {
  /** @type {{path: string, content: string}[]} */
  const out = [];
  if (!io.fs.existsSync(dir)) return out;
  for (const name of io.fs.readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (io.fs.statSync(p).isDirectory()) out.push(...allFiles(io, p));
    else out.push({ path: p, content: io.fs.readFileSync(p, 'utf8') });
  }
  return out;
}

const treeContainsSecret = (io) => allFiles(io, paths.dir).filter((f) => f.content.includes(SECRET));

// ===========================================================================
describe('purge-transcript — whole-tree secret removal', () => {
  it('the fixture actually plants the secret across the tree (guards against a vacuous pass)', () => {
    const io = makeIo({ files: fullTree() });
    const hits = treeContainsSecret(io);
    assert.ok(hits.length >= 5, `the planted secret must appear in every retained copy first; found in ${hits.length} files`);
  });

  it('removes the transcript from EVERY retained copy: no file under .handoff/ contains the secret afterward', async () => {
    const io = makeIo({ files: fullTree() });
    const code = await cmdPurgeTranscript([], io);
    assert.equal(code, 0, `purge should succeed; stderr: ${io.stderrText()}`);

    const hits = treeContainsSecret(io);
    assert.deepEqual(
      hits.map((f) => f.path),
      [],
      'the planted secret must be gone from the ENTIRE .handoff/ tree (snapshot, .bak, journal, history freeze + journal, log)',
    );
  });

  it('is surgical: the active snapshot loses ONLY its transcript; goal, decisions, journalSeq survive', async () => {
    const io = makeIo({ files: fullTree() });
    await cmdPurgeTranscript([], io);

    const snap = JSON.parse(io.files()[paths.snapshot]);
    assert.ok(!('transcript' in snap), 'the transcript field is removed from the active snapshot');
    assert.equal(snap.task.goal, 'Wire the purge command', 'the goal is preserved');
    assert.ok(snap.decisions.some((d) => d.summary === 'keep-this-decision'), 'decisions are preserved');
    assert.equal(snap.journalSeq, 2, 'journalSeq is preserved');
    assert.equal(snap.schema, 'baton/bundle@1', 'the bundle stays schema-valid');
  });
});

// ===========================================================================
describe('purge-transcript — marker-based interruption recovery', () => {
  it('writes and then clears a purge marker during a fresh run (marker-backed operation)', async () => {
    const io = makeIo({ files: fullTree() });
    await cmdPurgeTranscript([], io);

    const states = io.fs.__history.map((h) => h.files);
    const isMarker = (k) => /\.handoff\//.test(k) && /purge/i.test(k) && /marker/i.test(k);
    const iWritten = states.findIndex((f) => Object.keys(f).some(isMarker));
    assert.ok(iWritten !== -1, 'a purge marker is written at some point (marker-backed, not a lucky one-shot)');
    const iCleared = states.findIndex((f, idx) => idx > iWritten && !Object.keys(f).some(isMarker));
    assert.ok(iCleared !== -1, 'the purge marker is cleared once the whole tree is clean');
  });

  it('resumes an interrupted purge (leftover marker + partially-scrubbed tree) until the whole tree is clean', async () => {
    // Simulate a crash mid-purge: the snapshot was already scrubbed, but the .bak,
    // journal, history and log still carry the secret, and a marker is present.
    const io = makeIo({
      files: {
        ...fullTree(),
        // snapshot already clean (transcript removed by the interrupted run)
        [paths.snapshot]: snapText(baseBundle({ transcript: undefined })),
        // a leftover purge marker from the interrupted run
        [`${paths.dir}/purge.marker.json`]: JSON.stringify({ startedAt: T0 }),
      },
    });
    // Precondition: the tree is still dirty in the un-scrubbed copies.
    assert.ok(treeContainsSecret(io).length >= 4, 'the partially-purged tree still leaks the secret before resume');

    const code = await cmdPurgeTranscript([], io);
    assert.equal(code, 0);

    assert.deepEqual(treeContainsSecret(io).map((f) => f.path), [], 'resume scrubs every remaining copy until the tree is clean');
    const markerStillThere = allFiles(io, paths.dir).some((f) => /purge/i.test(f.path) && /marker/i.test(f.path));
    assert.equal(markerStillThere, false, 'the purge marker is cleared after a successful resume');
  });
});

// ===========================================================================
describe('purge-transcript — runs under the repo lock', () => {
  it('(F7) a live foreign lock blocks the purge: exit 1 and the ENTIRE memfs is byte-identical', async () => {
    const io = makeIo({
      files: {
        ...fullTree(),
        [`${paths.lockDir}/owner.json`]: JSON.stringify({ host: 'host-A', pid: 999999, startTime: 7, fencingToken: 'LIVE', acquiredAt: T0, heartbeatAt: T0 }),
      },
      processAlive: (pid) => pid === 999999 || pid === 4242,
    });
    const before = io.files();

    const code = await cmdPurgeTranscript([], io);
    assert.notEqual(code, 0, 'a live foreign lock makes purge a command failure (not a hook — it hard-fails)');
    // The essential safety property: under a foreign lock NOTHING is written —
    // no scrub, no marker, no log entry. A half-done purge that left some copies
    // leaking is exactly what the lock exists to prevent.
    assert.deepEqual(io.files(), before, 'a lock-refused purge leaves the ENTIRE memfs byte-identical (deep-equal, every file)');
  });
});

// ===========================================================================
describe('purge-transcript — (F8) retained copies are preserved, not deleted', () => {
  it('every retained copy survives with its non-transcript content intact; only transcript fields are removed', async () => {
    const io = makeIo({ files: fullTree() });
    const code = await cmdPurgeTranscript([], io);
    assert.equal(code, 0);
    const files = io.files();

    // .bak survives, parses, keeps its identity + decisions; transcript gone.
    const bakText = files[paths.bak];
    assert.ok(bakText, 'bundle.json.bak still exists — purging is scrubbing, not deleting');
    const bak = JSON.parse(bakText);
    assert.ok(!('transcript' in bak), 'the .bak transcript is removed');
    assert.equal(bak.bundleId, 'b_bak0000000000', 'the .bak keeps its bundleId');
    assert.ok(bak.decisions.some((d) => d.summary === 'keep-this-decision'), 'the .bak keeps its decisions');

    // The history FREEZE survives AT ITS PATH with its sealed state; transcript gone.
    const freezeText = files[`${paths.historyDir}/${FREEZE_STEM}.json`];
    assert.ok(freezeText, 'the history freeze still exists at its original path');
    const freeze = JSON.parse(freezeText);
    assert.ok(!('transcript' in freeze), 'the freeze transcript is removed');
    assert.equal(freeze.bundleId, 'b_frozen00000000', 'the freeze keeps its bundleId');
    assert.equal(freeze.handoff.status, 'sealed', 'the freeze keeps its sealed handoff block');

    // Every seeded journal EVENT survives somewhere under .handoff (live journal
    // or a history .ndjson — tolerant to rewrite-and-rotate), scrubbed of
    // transcripts but with its other payload fields preserved.
    const entries = [];
    for (const f of allFiles(io, paths.dir)) {
      if (!/\.ndjson$/.test(f.path)) continue;
      for (const line of f.content.split('\n')) {
        if (line.trim() === '') continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          assert.fail(`purge left an unparseable journal line in ${f.path}: ${line}`);
        }
      }
    }
    const byKey = (k) => entries.find((e) => e.dedupeKey === k);
    const k1 = byKey('k1');
    assert.ok(k1, 'the transcript-free journal event (k1) survives the purge');
    assert.equal(k1.payload.text, 'ok', 'k1 keeps its payload untouched');
    const k2 = byKey('k2');
    assert.ok(k2, 'the transcript-bearing journal event (k2) survives — scrubbed, not dropped');
    assert.equal(k2.payload.text, 'boundary', 'k2 keeps its non-transcript payload fields');
    assert.ok(!JSON.stringify(k2).includes(SECRET), 'k2 no longer carries the transcript secret');
    const h1 = byKey('h1');
    assert.ok(h1, 'the rotated-history journal event (h1) survives the purge');
    assert.ok(!JSON.stringify(h1).includes(SECRET), 'h1 no longer carries the transcript secret');

    // The diagnostics log entry keeps its metadata; the transcript is gone.
    const logFiles = allFiles(io, paths.logDir);
    assert.ok(logFiles.length > 0, 'the log file survives the purge');
    const logEntries = logFiles
      .flatMap((f) => f.content.split('\n'))
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l));
    const logEntry = logEntries.find((e) => e.event === 'precompact' && e.ts === T0);
    assert.ok(logEntry, 'the log entry keeps its ts/event metadata');
    assert.ok(!JSON.stringify(logEntry).includes(SECRET), 'the log entry no longer carries the secret');
  });
});

// ===========================================================================
describe('purge-transcript — no transcript anywhere', () => {
  it('a clean tree purges as a no-op: exit 0, bundle byte-identical', async () => {
    const clean = snapText(baseBundle({ transcript: undefined }));
    const io = makeIo({ files: { [paths.snapshot]: clean, [paths.journal]: JSON.stringify({ seq: 1, ts: T0, type: 'note', dedupeKey: 'k', source: 'stop', payload: { text: 'ok' } }) + '\n' } });
    const before = io.files();

    const code = await cmdPurgeTranscript([], io);
    assert.equal(code, 0);
    assert.equal(io.files()[paths.snapshot], before[paths.snapshot], 'a bundle with no transcript is left byte-identical');
  });
});
