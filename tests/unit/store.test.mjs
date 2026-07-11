import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import {
  bundlePaths,
  loadBundle,
  writeSnapshot,
  appendJournal,
  rotateJournal,
} from '../../core/src/bundle/store.mjs';
import { applyEvent } from '../../core/src/bundle/merge.mjs';
import { readAllTolerant } from '../../core/src/util/jsonl.mjs';

// ---------------------------------------------------------------------------
// Contract choices for bundle/store.mjs (docs/design/core.md §Module APIs,
// §store test list; plan §Bundle, §Concurrency, §"Journal rotation & crash
// recovery"). Readings pinned where the design left room:
//
//   1. PATHS — everything is rooted at `<root>/.handoff/`. `.bak` is the
//      snapshot path + ".bak" (i.e. bundle.json.bak), matching fsx.backupThenWrite
//      and fsx documentation. Exact set asserted in the bundlePaths test.
//   2. loadBundle NULL — returns {bundle:null, warnings:[]} when the .handoff
//      dir is absent OR neither a snapshot nor a journal exists. Warnings is
//      ALWAYS an array of human-readable STRINGS (the API declares string[]);
//      jsonl's structured {kind,line} warnings are surfaced as formatted strings,
//      not raw objects.
//   3. REPLAY — with a valid snapshot present, loadBundle applies exactly the
//      journal entries whose seq > bundle.journalSeq, in journal (file) order,
//      via merge.applyEvent. This must equal a pure left-fold of those same
//      entries over the snapshot — the load path adds no hidden behavior. The
//      seq>journalSeq FILTER is load-owned and independent of dedupe: the
//      replay-boundary test drives a snapshot with an EMPTY dedupeRing so an
//      implementation that wrongly folds the WHOLE journal cannot hide behind the
//      ring — the pre-boundary events would visibly reappear in decisions.
//   4. RECOVERY LADDER — snapshot that fails to parse OR fails validateBundle →
//      try bundle.json.bak (parse+validate); if that is good, replay over IT
//      (seq > bak.journalSeq). If BOTH snapshot and .bak are unusable → full
//      rebuild by seeding an empty bundle and replaying the WHOLE journal. Every
//      recovery emits at least one warning string.
//   5. TORN TAIL — a torn final journal line is tolerated (jsonl drops it); the
//      torn-tail warning is surfaced. Leftover *.tmp.* siblings are ignored by
//      load (safeReadJson reads the real file).
//   6. ROTATION FILE FORMAT — the history stem is
//         `${tsForFile(startedAt)}.${kind}`  where  tsForFile(iso)=iso.replace(/[:.]/g,'-')
//      producing `history/<stem>.json` (frozen snapshot copy) and
//      `history/<stem>.ndjson` (rotated journal). rotateJournal RETURNS the stem.
//      The transform is pinned HERE so the manually-constructed crash states in
//      the roll-forward/back tests name files exactly where loadBundle looks.
//   7. ROTATION ORDER (crash-safe, plan §rotation): write
//      `.handoff/rotation.marker.json` {kind, startedAt, seq} → freeze snapshot
//      to history/<stem>.json → rename journal to history/<stem>.ndjson → start a
//      fresh empty journal → clear the marker.
//   8. MARKER RECONCILIATION — on load, a leftover marker rolls FORWARD when the
//      freeze (history/<stem>.json, stem recomputed from marker.startedAt+kind)
//      landed, else rolls BACK (clear marker, leave the live journal untouched).
//      Both cases warn. Roll-forward completes from WHICHEVER step the crash
//      interrupted: if the live journal has not yet been renamed to
//      history/<stem>.ndjson, load performs that rename (losing no entries) and
//      then seeds a fresh empty live journal; the near-complete state (freeze +
//      rotated journal + empty live journal already present) is handled too.
//   9. RETENTION — after a rotation, only the newest 10 rotations PER KIND are
//      kept in history/ (both the .json and .ndjson of pruned rotations removed).
//  10. writeSnapshot backs up the previous good snapshot to .bak, writes the new
//      snapshot atomically (tmp+rename, via fsx), and renders HANDOFF.md
//      alongside by delegating to render.mjs. This file proves the delegation
//      via render's signature (the pinned footer + the goal) WITHOUT importing
//      render — render.test owns the exact format.
//  11. appendJournal runs UNDER THE REPO LOCK (see 12), ensures `.handoff/`
//      exists, appends the entry via jsonl, and returns the entry's seq. SEQ
//      ALLOCATION: an entry that already carries a numeric `seq` keeps it
//      (adapter-normalized events arrive pre-numbered). An entry that LACKS a seq
//      is assigned the next one under the lock — max(snapshot.journalSeq, highest
//      seq already in the journal) + 1, monotonic across calls — and that
//      allocated seq is both stamped onto the appended entry AND returned.
//  12. REPO LOCK — writeSnapshot, appendJournal, and rotateJournal are MUTATIONS
//      and run under bundle/lock.mjs's withLock (acquire → mutate → release).
//      With a LIVE same-host foreign owner already holding `.handoff/lock/`, each
//      throws LockHeldError (surfaced verbatim from the lock layer) and leaves
//      every file byte-for-byte unchanged — a refused mutation is a no-op.
//      loadBundle is a READ/recovery path and is NOT lock-gated (marker
//      reconciliation is part of load).
// ---------------------------------------------------------------------------

const T0 = '2026-07-11T00:00:00.000Z';
const T1 = '2026-07-11T01:00:00.000Z';

// A LIVE same-host foreign owner already holding the repo lock. processAlive
// must report this pid alive so the lock layer refuses (never steals) it.
const LOCK_OWNER = '/repo/.handoff/lock/owner.json';
const liveForeignOwner = {
  host: 'host-A', // same host as the default makeIo() identity
  pid: 777, // a DIFFERENT process than this io's pid 4242
  startTime: 42,
  fencingToken: 'LIVE',
  acquiredAt: T0,
  heartbeatAt: T0,
};

const tsForFile = (iso) => iso.replace(/[:.]/g, '-');

function mkBundle(overrides = {}) {
  const b = {
    schema: 'baton/bundle@1',
    bundleId: 'b_store000000000',
    generation: 1,
    createdAt: T0,
    updatedAt: T0,
    origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: null, unstable: false },
    task: { goal: 'Build the store', constraints: [], acceptance: [] },
    plan: { steps: [] },
    decisions: [],
    files: { touched: [] },
    roles: { assignments: {} },
    git: null,
    handoff: {
      status: 'open',
      reason: null,
      reasonClass: null,
      toPlatformHint: null,
      finalizedAt: null,
      receive_log: [],
    },
    journalSeq: 0,
    compaction: { droppedDecisions: 0, note: null },
    dedupeRing: [],
  };
  return { ...b, ...overrides };
}

function ev(overrides = {}) {
  return {
    seq: 1,
    ts: T1,
    type: 'note',
    dedupeKey: 'k',
    writerId: 'claude-code-1',
    source: 'stop',
    payload: {},
    ...overrides,
  };
}

// A seq-less event as an adapter that did NOT pre-number would hand it in — the
// store must allocate the seq. `delete` (not `seq: undefined`) so the property is
// truly absent, matching the "lacks a seq" branch.
function evNoSeq(overrides = {}) {
  const e = ev(overrides);
  delete e.seq;
  return e;
}

const snapText = (bundle) => JSON.stringify(bundle, null, 2) + '\n';
const journalText = (entries) => (entries.length ? entries.map((e) => JSON.stringify(e)).join('\n') + '\n' : '');

const isTmp = (name) => /\.tmp\./.test(name);

// ===========================================================================

describe('store.bundlePaths', () => {
  it('roots the full path set at <root>/.handoff/', () => {
    assert.deepEqual(bundlePaths('/repo'), {
      dir: '/repo/.handoff',
      snapshot: '/repo/.handoff/bundle.json',
      bak: '/repo/.handoff/bundle.json.bak',
      journal: '/repo/.handoff/journal.ndjson',
      handoffMd: '/repo/.handoff/HANDOFF.md',
      historyDir: '/repo/.handoff/history',
      lockDir: '/repo/.handoff/lock',
      logDir: '/repo/.handoff/log',
    });
  });
});

describe('store.loadBundle — fresh and happy paths', () => {
  it('returns {bundle:null, warnings:[]} when the .handoff dir is absent', () => {
    const io = makeIo();
    const { bundle, warnings } = loadBundle('/repo', io);
    assert.equal(bundle, null);
    assert.deepEqual(warnings, []);
  });

  it('returns null when the dir exists but neither snapshot nor journal is present', () => {
    const io = makeIo({ files: { '/repo/.handoff/log/.keep': '' } });
    const { bundle } = loadBundle('/repo', io);
    assert.equal(bundle, null);
  });

  it('returns the parsed snapshot unchanged when there is no journal', () => {
    const snap = mkBundle({ journalSeq: 3, task: { goal: 'g', constraints: [], acceptance: [] } });
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': snapText(snap) } });
    const { bundle, warnings } = loadBundle('/repo', io);
    assert.deepEqual(bundle, snap);
    assert.deepEqual(warnings, []);
  });

  it('snapshot + journal replay EQUALS a pure reduction over the same events (seq > journalSeq)', () => {
    const base = mkBundle();
    const e1 = ev({ seq: 1, type: 'decision', dedupeKey: 'k1', payload: { summary: 'one' } });
    const e2 = ev({ seq: 2, type: 'decision', dedupeKey: 'k2', payload: { summary: 'two' } });
    const e3 = ev({ seq: 3, type: 'decision', dedupeKey: 'k3', payload: { summary: 'three' } });
    const e4 = ev({ seq: 4, type: 'file.touch', dedupeKey: 'k4', payload: { path: 'a.mjs', op: 'edit' } });
    const all = [e1, e2, e3, e4];

    // The snapshot genuinely reflects e1,e2 (journalSeq becomes 2).
    const snap = [e1, e2].reduce(applyEvent, base);
    const io = makeIo({
      files: {
        '/repo/.handoff/bundle.json': snapText(snap),
        '/repo/.handoff/journal.ndjson': journalText(all),
      },
    });

    const { bundle, warnings } = loadBundle('/repo', io);
    const expected = all.filter((e) => e.seq > snap.journalSeq).reduce(applyEvent, snap);
    assert.deepEqual(bundle, expected, 'load must equal the pure fold of seq>journalSeq events over the snapshot');
    assert.equal(bundle.journalSeq, 4);
    assert.deepEqual(warnings, []);
  });

  it('replays ONLY entries with seq > journalSeq, proven with an EMPTY dedupeRing (no dedupe masking)', () => {
    // The snapshot claims journalSeq 5 but carries an EMPTY dedupeRing. If the
    // implementation folds the WHOLE journal instead of filtering on seq, the
    // stale seq-3/4 events WOULD apply (nothing in the ring to no-op them) and
    // their summaries would surface. Correct behavior applies only seq 6 and 7.
    const snap = mkBundle({ journalSeq: 5, dedupeRing: [] });
    const e3 = ev({ seq: 3, type: 'decision', dedupeKey: 'stale3', payload: { summary: 'STALE-three' } });
    const e4 = ev({ seq: 4, type: 'decision', dedupeKey: 'stale4', payload: { summary: 'STALE-four' } });
    const e6 = ev({ seq: 6, type: 'decision', dedupeKey: 'new6', payload: { summary: 'NEW-six' } });
    const e7 = ev({ seq: 7, type: 'decision', dedupeKey: 'new7', payload: { summary: 'NEW-seven' } });
    const io = makeIo({
      files: {
        '/repo/.handoff/bundle.json': snapText(snap),
        '/repo/.handoff/journal.ndjson': journalText([e3, e4, e6, e7]),
      },
    });

    const { bundle, warnings } = loadBundle('/repo', io);
    const summaries = bundle.decisions.map((d) => d.summary);
    assert.ok(!summaries.includes('STALE-three'), 'seq 3 (<= journalSeq) must NOT be replayed');
    assert.ok(!summaries.includes('STALE-four'), 'seq 4 (<= journalSeq) must NOT be replayed');
    assert.ok(summaries.includes('NEW-six'), 'seq 6 (> journalSeq) must be applied');
    assert.ok(summaries.includes('NEW-seven'), 'seq 7 (> journalSeq) must be applied');
    assert.deepEqual(summaries, ['NEW-six', 'NEW-seven'], 'exactly and only the post-boundary events, in journal order');
    assert.deepEqual(bundle, [e6, e7].reduce(applyEvent, snap), 'equals the pure fold of only seq>5 events');
    assert.equal(bundle.journalSeq, 7);
    assert.deepEqual(warnings, []);
  });

  it('ignores a leftover *.tmp.* sibling of the snapshot', () => {
    const snap = mkBundle({ journalSeq: 1 });
    const io = makeIo({
      files: {
        '/repo/.handoff/bundle.json': snapText(snap),
        '/repo/.handoff/bundle.json.tmp.9': 'half-written-garbage{',
      },
    });
    const { bundle, warnings } = loadBundle('/repo', io);
    assert.deepEqual(bundle, snap);
    assert.deepEqual(warnings, []);
  });

  it('tolerates a torn journal tail and surfaces a torn-tail warning', () => {
    const snap = mkBundle();
    const e1 = ev({ seq: 1, type: 'decision', dedupeKey: 'k1', payload: { summary: 'one' } });
    const e2 = ev({ seq: 2, type: 'decision', dedupeKey: 'k2', payload: { summary: 'two' } });
    const torn = journalText([e1, e2]) + '{"seq":3,"type":"deci'; // unterminated last line
    const io = makeIo({
      files: {
        '/repo/.handoff/bundle.json': snapText(snap),
        '/repo/.handoff/journal.ndjson': torn,
      },
    });
    const { bundle, warnings } = loadBundle('/repo', io);
    assert.deepEqual(bundle, [e1, e2].reduce(applyEvent, snap));
    assert.ok(
      warnings.some((w) => typeof w === 'string' && /torn/i.test(w)),
      'a torn-tail warning string must be surfaced',
    );
  });
});

describe('store.loadBundle — recovery', () => {
  it('recovers from bundle.json.bak when the snapshot fails to parse (with a warning)', () => {
    const base = mkBundle();
    const e1 = ev({ seq: 1, type: 'decision', dedupeKey: 'k1', payload: { summary: 'one' } });
    const e2 = ev({ seq: 2, type: 'decision', dedupeKey: 'k2', payload: { summary: 'two' } });
    const e3 = ev({ seq: 3, type: 'decision', dedupeKey: 'k3', payload: { summary: 'three' } });
    const e4 = ev({ seq: 4, type: 'file.touch', dedupeKey: 'k4', payload: { path: 'x.mjs', op: 'create' } });
    const bak = [e1, e2].reduce(applyEvent, base); // journalSeq 2

    const io = makeIo({
      files: {
        '/repo/.handoff/bundle.json': 'totally corrupt not json {',
        '/repo/.handoff/bundle.json.bak': snapText(bak),
        '/repo/.handoff/journal.ndjson': journalText([e1, e2, e3, e4]),
      },
    });

    const { bundle, warnings } = loadBundle('/repo', io);
    assert.deepEqual(bundle, [e3, e4].reduce(applyEvent, bak));
    assert.ok(
      warnings.some((w) => /bak|backup|recover/i.test(w)),
      'recovery from .bak must be flagged in warnings',
    );
  });

  it('recovers from .bak when the snapshot parses but fails schema validation', () => {
    const bak = mkBundle({ journalSeq: 0 });
    const badSchema = mkBundle({ schema: 'baton/bundle@2' }); // parses fine, invalid schema
    const io = makeIo({
      files: {
        '/repo/.handoff/bundle.json': snapText(badSchema),
        '/repo/.handoff/bundle.json.bak': snapText(bak),
      },
    });
    const { bundle, warnings } = loadBundle('/repo', io);
    assert.deepEqual(bundle, bak);
    assert.ok(warnings.some((w) => /schema|invalid|bak|recover/i.test(w)));
  });

  it('rebuilds from the whole journal when BOTH snapshot and .bak are corrupt (with a warning)', () => {
    const e1 = ev({ seq: 1, type: 'decision', dedupeKey: 'k1', payload: { summary: 'alpha' } });
    const e2 = ev({ seq: 2, type: 'decision', dedupeKey: 'k2', payload: { summary: 'beta' } });
    const e3 = ev({ seq: 3, type: 'decision', dedupeKey: 'k3', payload: { summary: 'gamma' } });
    const io = makeIo({
      files: {
        '/repo/.handoff/bundle.json': 'corrupt {',
        '/repo/.handoff/bundle.json.bak': 'also corrupt {',
        '/repo/.handoff/journal.ndjson': journalText([e1, e2, e3]),
      },
    });

    const { bundle, warnings } = loadBundle('/repo', io);
    assert.notEqual(bundle, null, 'a rebuild must produce a bundle, never null');
    assert.equal(bundle.schema, 'baton/bundle@1');
    assert.equal(bundle.journalSeq, 3, 'rebuild folds the whole journal');
    assert.deepEqual(
      bundle.decisions.map((d) => d.summary),
      ['alpha', 'beta', 'gamma'],
      'every journal event must be replayed over the seed',
    );
    assert.ok(warnings.some((w) => /rebuild|journal|recover/i.test(w)));
  });
});

describe('store.loadBundle — rotation marker reconciliation', () => {
  it('rolls the rotation FORWARD when the history freeze landed (clears marker, keeps an empty journal)', () => {
    const startedAt = '2026-07-11T00:00:00.000Z';
    const stem = `${tsForFile(startedAt)}.finalize`;
    const snap = mkBundle({ journalSeq: 5 });
    const oldEntries = [ev({ seq: 4, dedupeKey: 'o4' }), ev({ seq: 5, dedupeKey: 'o5' })];

    const io = makeIo({
      files: {
        '/repo/.handoff/bundle.json': snapText(snap),
        '/repo/.handoff/rotation.marker.json': JSON.stringify({ kind: 'finalize', startedAt, seq: 5 }),
        [`/repo/.handoff/history/${stem}.json`]: snapText(snap), // freeze LANDED
        [`/repo/.handoff/history/${stem}.ndjson`]: journalText(oldEntries), // journal already rotated
        '/repo/.handoff/journal.ndjson': '', // fresh empty live journal already created
      },
    });
    const paths = bundlePaths('/repo');

    const { bundle, warnings } = loadBundle('/repo', io);

    assert.equal(io.fs.existsSync(paths.dir + '/rotation.marker.json'), false, 'marker must be cleared on roll-forward');
    assert.ok(io.fs.existsSync(paths.journal), 'a fresh live journal must remain');
    assert.equal(readAllTolerant(io.fs, paths.journal).entries.length, 0, 'the live journal is empty after roll-forward');
    assert.ok(io.fs.existsSync(`${paths.historyDir}/${stem}.json`), 'the history freeze is retained');
    assert.ok(io.fs.existsSync(`${paths.historyDir}/${stem}.ndjson`), 'the rotated journal is retained');
    assert.deepEqual(bundle, snap, 'with an empty journal, the load equals the snapshot');
    assert.ok(warnings.some((w) => /rotation|roll|marker/i.test(w)), 'roll-forward must warn');
  });

  it('rolls FORWARD from the INTERMEDIATE crash: freeze landed but the journal was not yet renamed', () => {
    // Crash point: marker written + history freeze (.json) landed, but the live
    // journal was NOT yet renamed to history/<stem>.ndjson and no fresh journal
    // exists. Load must COMPLETE the rotation — rename the journal alongside the
    // freeze (losing no entries), seed a fresh empty live journal, clear marker.
    const startedAt = '2026-07-11T00:00:00.000Z';
    const stem = `${tsForFile(startedAt)}.finalize`;
    const snap = mkBundle({ journalSeq: 5 });
    const oldEntries = [ev({ seq: 4, dedupeKey: 'o4' }), ev({ seq: 5, dedupeKey: 'o5' })];
    const liveJournal = journalText(oldEntries);

    const io = makeIo({
      files: {
        '/repo/.handoff/bundle.json': snapText(snap),
        '/repo/.handoff/rotation.marker.json': JSON.stringify({ kind: 'finalize', startedAt, seq: 5 }),
        [`/repo/.handoff/history/${stem}.json`]: snapText(snap), // freeze LANDED
        // NO history/<stem>.ndjson yet — the journal rename never happened.
        '/repo/.handoff/journal.ndjson': liveJournal, // still the ORIGINAL journal, not yet rotated
      },
    });
    const paths = bundlePaths('/repo');

    const { bundle, warnings } = loadBundle('/repo', io);

    assert.equal(io.fs.existsSync(paths.dir + '/rotation.marker.json'), false, 'marker cleared once the rotation is completed');
    assert.ok(io.fs.existsSync(`${paths.historyDir}/${stem}.json`), 'the history freeze is retained');
    assert.ok(io.fs.existsSync(`${paths.historyDir}/${stem}.ndjson`), 'the journal was renamed alongside the freeze to finish the rotation');
    assert.equal(io.files()[`${paths.historyDir}/${stem}.ndjson`], liveJournal, 'no journal entries are lost in the completed rename');
    assert.ok(io.fs.existsSync(paths.journal), 'a fresh live journal exists');
    assert.equal(readAllTolerant(io.fs, paths.journal).entries.length, 0, 'the fresh live journal is empty');
    assert.deepEqual(bundle, snap, 'with the rotation completed the load equals the frozen snapshot');
    assert.ok(warnings.some((w) => /rotation|roll|marker/i.test(w)), 'completing the interrupted roll-forward must warn');
  });

  it('rolls the rotation BACK when the history freeze did NOT land (clears marker, preserves the live journal)', () => {
    const startedAt = '2026-07-11T00:00:00.000Z';
    const stem = `${tsForFile(startedAt)}.finalize`;
    const snap = mkBundle({ journalSeq: 5 });
    const e6 = ev({ seq: 6, type: 'decision', dedupeKey: 'k6', payload: { summary: 'six' } });
    const e7 = ev({ seq: 7, type: 'decision', dedupeKey: 'k7', payload: { summary: 'seven' } });
    const liveJournal = journalText([e6, e7]);

    const io = makeIo({
      files: {
        '/repo/.handoff/bundle.json': snapText(snap),
        '/repo/.handoff/rotation.marker.json': JSON.stringify({ kind: 'finalize', startedAt, seq: 5 }),
        '/repo/.handoff/journal.ndjson': liveJournal, // still the original entries; freeze never happened
      },
    });
    const paths = bundlePaths('/repo');

    const { bundle, warnings } = loadBundle('/repo', io);

    assert.equal(io.fs.existsSync(paths.dir + '/rotation.marker.json'), false, 'marker must be cleared on roll-back');
    assert.equal(io.files()[paths.journal], liveJournal, 'the live journal must be preserved intact on roll-back');
    assert.equal(io.fs.existsSync(`${paths.historyDir}/${stem}.json`), false, 'roll-back must not create a freeze');
    assert.deepEqual(bundle, [e6, e7].reduce(applyEvent, snap), 'the aborted rotation still loads snapshot + journal');
    assert.ok(warnings.some((w) => /rotation|roll|marker|abort/i.test(w)), 'roll-back must warn');
  });
});

describe('store.writeSnapshot', () => {
  it('writes pretty JSON atomically and renders HANDOFF.md alongside (no prior snapshot)', () => {
    const io = makeIo();
    const bundle = mkBundle({ task: { goal: 'A distinctive goal string', constraints: [], acceptance: [] } });

    writeSnapshot('/repo', bundle, io);
    const paths = bundlePaths('/repo');
    const after = io.files();

    assert.equal(after[paths.snapshot], snapText(bundle), 'snapshot is pretty 2-space JSON + trailing newline');
    assert.equal(after[paths.bak], undefined, 'no .bak when there was no previous snapshot');

    const md = after[paths.handoffMd];
    assert.ok(typeof md === 'string' && md.length > 0, 'HANDOFF.md must be rendered');
    assert.ok(md.includes('A distinctive goal string'), 'HANDOFF.md reflects the bundle goal');
    assert.ok(
      md.includes('Machine-readable data: .handoff/bundle.json (baton bundle schema v1)'),
      'HANDOFF.md carries render.mjs\'s pinned footer (proves delegation)',
    );

    // Atomicity: the snapshot became visible via a rename of a tmp sibling.
    assert.ok(io.fs.__history.some((h) => Object.keys(h.files).some(isTmp)), 'a tmp sibling must have existed mid-write');
  });

  it('backs up the previous good snapshot to .bak before overwriting', () => {
    const prev = mkBundle({ task: { goal: 'OLD goal', constraints: [], acceptance: [] } });
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': snapText(prev) } });
    const next = mkBundle({ generation: 2, task: { goal: 'NEW goal', constraints: [], acceptance: [] } });

    writeSnapshot('/repo', next, io);
    const paths = bundlePaths('/repo');
    const after = io.files();

    assert.equal(after[paths.bak], snapText(prev), 'previous snapshot copied to .bak');
    assert.equal(after[paths.snapshot], snapText(next), 'new snapshot written');
    assert.ok(after[paths.handoffMd].includes('NEW goal'), 'HANDOFF.md re-rendered from the new bundle');
  });
});

describe('store.appendJournal', () => {
  it('appends the entry and returns its seq, creating .handoff/ if needed', () => {
    const io = makeIo();
    const entry = ev({ seq: 7, type: 'decision', dedupeKey: 'k7', payload: { summary: 'lucky' } });

    const seq = appendJournal('/repo', entry, io);
    assert.equal(seq, 7);

    const paths = bundlePaths('/repo');
    const { entries } = readAllTolerant(io.fs, paths.journal);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], entry);
  });

  it('appends in order across calls', () => {
    const io = makeIo({ files: { '/repo/.handoff/log/.keep': '' } });
    appendJournal('/repo', ev({ seq: 1, dedupeKey: 'a' }), io);
    const s2 = appendJournal('/repo', ev({ seq: 2, dedupeKey: 'b' }), io);
    assert.equal(s2, 2);
    const { entries } = readAllTolerant(io.fs, bundlePaths('/repo').journal);
    assert.deepEqual(entries.map((e) => e.seq), [1, 2]);
  });

  it('allocates a seq for a seq-less entry, continuing from max(snapshot.journalSeq, last journal seq)', () => {
    // Snapshot journalSeq 5; journal already holds seq 6 and 7. The next
    // allocation must continue from max(5, 7) = 7, i.e. 8, 9, 10.
    const snap = mkBundle({ journalSeq: 5 });
    const existing = [ev({ seq: 6, dedupeKey: 'e6' }), ev({ seq: 7, dedupeKey: 'e7' })];
    const io = makeIo({
      files: {
        '/repo/.handoff/bundle.json': snapText(snap),
        '/repo/.handoff/journal.ndjson': journalText(existing),
      },
    });

    const s1 = appendJournal('/repo', evNoSeq({ dedupeKey: 'n1' }), io);
    const s2 = appendJournal('/repo', evNoSeq({ dedupeKey: 'n2' }), io);
    const s3 = appendJournal('/repo', evNoSeq({ dedupeKey: 'n3' }), io);
    assert.deepEqual([s1, s2, s3], [8, 9, 10], 'seqs are allocated monotonically past the current max');

    const { entries } = readAllTolerant(io.fs, bundlePaths('/repo').journal);
    assert.deepEqual(entries.map((e) => e.seq), [6, 7, 8, 9, 10], 'the allocated seq is stamped onto each appended entry');
  });

  it('allocates from the snapshot journalSeq when it exceeds the last journal seq', () => {
    // journalSeq 20 but the journal only has seq 6,7 (older tail): the boundary
    // is the SNAPSHOT, so the next allocation is 21, not 8.
    const snap = mkBundle({ journalSeq: 20 });
    const io = makeIo({
      files: {
        '/repo/.handoff/bundle.json': snapText(snap),
        '/repo/.handoff/journal.ndjson': journalText([ev({ seq: 6, dedupeKey: 'e6' }), ev({ seq: 7, dedupeKey: 'e7' })]),
      },
    });
    const s = appendJournal('/repo', evNoSeq({ dedupeKey: 'nn' }), io);
    assert.equal(s, 21, 'allocation continues from max(journalSeq=20, lastJournalSeq=7) + 1');
  });

  it('keeps a seq the entry already carries (adapter-normalized events are not renumbered)', () => {
    const snap = mkBundle({ journalSeq: 5 });
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': snapText(snap) } });
    const s = appendJournal('/repo', ev({ seq: 100, dedupeKey: 'pinned' }), io);
    assert.equal(s, 100, 'a pre-numbered entry keeps its seq even past the snapshot journalSeq');
    const { entries } = readAllTolerant(io.fs, bundlePaths('/repo').journal);
    assert.equal(entries[0].seq, 100);
  });
});

describe('store.rotateJournal', () => {
  it('happy path: freezes the snapshot + journal into history, empties the live journal, clears the marker', () => {
    const snap = mkBundle({ journalSeq: 5 });
    const entries = [ev({ seq: 4, dedupeKey: 'a' }), ev({ seq: 5, dedupeKey: 'b' })];
    const io = makeIo({
      files: {
        '/repo/.handoff/bundle.json': snapText(snap),
        '/repo/.handoff/journal.ndjson': journalText(entries),
      },
    });
    io.setNow('2026-07-11T12:00:00.000Z');

    const stem = rotateJournal('/repo', 'finalize', io);
    const paths = bundlePaths('/repo');
    const after = io.files();

    assert.equal(typeof stem, 'string');
    assert.ok(stem.endsWith('.finalize'), 'the returned basename must carry the rotation kind');

    // history gained exactly the two files for this rotation.
    assert.equal(after[`${paths.historyDir}/${stem}.json`], snapText(snap), 'frozen snapshot copy');
    assert.equal(after[`${paths.historyDir}/${stem}.ndjson`], journalText(entries), 'rotated journal copy');

    // live journal is now empty; marker gone.
    assert.ok(io.fs.existsSync(paths.journal), 'a fresh live journal exists');
    assert.equal(readAllTolerant(io.fs, paths.journal).entries.length, 0, 'the live journal was emptied');
    assert.equal(io.fs.existsSync(paths.dir + '/rotation.marker.json'), false, 'the marker is cleared on success');
  });

  it('retention: keeps only the newest 10 rotations PER KIND', () => {
    const snap = mkBundle({ journalSeq: 0 });
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': snapText(snap) } });
    const paths = bundlePaths('/repo');

    // Two takeover rotations — these must survive finalize pruning (per-kind).
    for (let i = 0; i < 2; i += 1) {
      io.setNow(`2026-07-11T10:0${i}:00.000Z`);
      appendJournal('/repo', ev({ seq: 200 + i, dedupeKey: `tk${i}` }), io);
      rotateJournal('/repo', 'takeover', io);
    }

    // Eleven finalize rotations — the oldest must be pruned to 10.
    const finalizeStems = [];
    for (let i = 0; i < 11; i += 1) {
      const mm = String(i).padStart(2, '0');
      io.setNow(`2026-07-11T11:${mm}:00.000Z`);
      appendJournal('/repo', ev({ seq: 1 + i, dedupeKey: `fk${i}` }), io);
      finalizeStems.push(rotateJournal('/repo', 'finalize', io));
    }

    const names = io.fs.readdirSync(paths.historyDir);
    assert.equal(names.filter((n) => /\.finalize\.json$/.test(n)).length, 10, 'exactly 10 finalize freezes retained');
    assert.equal(names.filter((n) => /\.finalize\.ndjson$/.test(n)).length, 10, 'exactly 10 finalize journals retained');
    assert.equal(names.filter((n) => /\.takeover\.json$/.test(n)).length, 2, 'takeover rotations pruned independently');

    assert.ok(!names.includes(`${finalizeStems[0]}.json`), 'the oldest finalize freeze was pruned');
    assert.ok(names.includes(`${finalizeStems[10]}.json`), 'the newest finalize freeze was kept');
  });
});

describe('store — mutations run under the repo lock', () => {
  // With a LIVE same-host foreign owner holding `.handoff/lock/`, every store
  // MUTATION must be refused by the lock layer (LockHeldError) and leave the
  // whole `.handoff/` tree byte-for-byte unchanged. This is what proves the
  // mutations actually acquire the lock rather than writing unlocked.
  const withLiveForeignLock = (files) =>
    makeIo({
      files: { [LOCK_OWNER]: JSON.stringify(liveForeignOwner), ...files },
      processAlive: (pid) => pid === 777 || pid === 4242, // pid 777 (the owner) is alive
    });
  const isLockHeld = (e) => e && e.name === 'LockHeldError';

  it('writeSnapshot throws LockHeldError under a live foreign lock and changes nothing', () => {
    const prev = mkBundle({ task: { goal: 'PREV goal', constraints: [], acceptance: [] } });
    const io = withLiveForeignLock({ '/repo/.handoff/bundle.json': snapText(prev) });
    const before = io.files();

    assert.throws(
      () => writeSnapshot('/repo', mkBundle({ generation: 2, task: { goal: 'NEW goal', constraints: [], acceptance: [] } }), io),
      isLockHeld,
    );

    const after = io.files();
    assert.deepEqual(after, before, 'no file may change when a live foreign owner holds the lock');
    assert.equal(after['/repo/.handoff/bundle.json'], snapText(prev), 'the existing snapshot is untouched');
    assert.equal(after['/repo/.handoff/bundle.json.bak'], undefined, 'no .bak is written under a refused lock');
    assert.equal(after['/repo/.handoff/HANDOFF.md'], undefined, 'HANDOFF.md is not rendered under a refused lock');
    assert.deepEqual(JSON.parse(after[LOCK_OWNER]), liveForeignOwner, 'the foreign owner.json is never modified');
  });

  it('appendJournal throws LockHeldError under a live foreign lock and changes nothing', () => {
    const existing = [ev({ seq: 6, dedupeKey: 'e6' })];
    const io = withLiveForeignLock({ '/repo/.handoff/journal.ndjson': journalText(existing) });
    const before = io.files();

    assert.throws(() => appendJournal('/repo', ev({ seq: 7, dedupeKey: 'e7' }), io), isLockHeld);
    assert.throws(() => appendJournal('/repo', evNoSeq({ dedupeKey: 'e8' }), io), isLockHeld);

    assert.deepEqual(io.files(), before, 'the journal is not appended (and no seq allocated) under a refused lock');
    assert.equal(io.files()['/repo/.handoff/journal.ndjson'], journalText(existing), 'the journal bytes are unchanged');
  });

  it('rotateJournal throws LockHeldError under a live foreign lock and changes nothing', () => {
    const snap = mkBundle({ journalSeq: 5 });
    const entries = [ev({ seq: 4, dedupeKey: 'a' }), ev({ seq: 5, dedupeKey: 'b' })];
    const io = withLiveForeignLock({
      '/repo/.handoff/bundle.json': snapText(snap),
      '/repo/.handoff/journal.ndjson': journalText(entries),
    });
    const before = io.files();

    assert.throws(() => rotateJournal('/repo', 'finalize', io), isLockHeld);

    const after = io.files();
    assert.deepEqual(after, before, 'nothing rotates when a live foreign owner holds the lock');
    assert.equal(after['/repo/.handoff/journal.ndjson'], journalText(entries), 'the live journal is untouched');
    assert.equal(io.fs.existsSync('/repo/.handoff/rotation.marker.json'), false, 'no rotation marker is written under a refused lock');
    assert.equal(io.fs.existsSync('/repo/.handoff/history'), false, 'no history freeze is created under a refused lock');
  });
});
