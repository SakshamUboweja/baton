import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compact } from '../../core/src/bundle/compact.mjs';

// ---------------------------------------------------------------------------
// Contract choices recorded for this module (docs/design/core.md §Bundle schema
// "Size budget", §Module APIs; plan §Core engine — Bundle "deterministic
// truncation only"). Readings the tests pin where the spec was open:
//   1. DECISIONS threshold is a hard MAX of 200: length <= 200 is under budget
//      (untouched); length > 200 collapses to first-20 + one marker + last-150
//      (= 171 entries). The marker's N = omitted count = original.length - 170.
//   2. The marker entry carries at least {summary: EXACT_TEXT}. Its summary must
//      match the documented format byte-for-byte (em dash U+2014, the literal
//      "journal.ndjson"); extra bookkeeping fields on the marker are tolerated,
//      so we assert the summary, not deepEqual the whole entry.
//   3. DETAIL is hard-capped so the resulting string length is EXACTLY 2000
//      chars, ending in the suffix '…[truncated]' (design says "detail <= 2000
//      chars", so the suffix is counted within the cap, not appended past it).
//   4. FILES.touched max is 300; when exceeded, the 300 entries with the NEWEST
//      lastTs are kept, the oldest are evicted, and files.truncated is set true
//      (the flag documented under `files` in §Bundle schema). Resulting array
//      ORDER is not pinned (only membership + count).
//   5. compaction.droppedDecisions ACCUMULATES onto its prior value (adds N),
//      it does not reset.
//   6. Only the documented default budget is exercised (compact(bundle) with no
//      second arg); the optional custom-budget object shape is unspecified, so it
//      is intentionally not pinned here.
//   7. GIT.dirtySummary is an array of lines (schema: `dirtySummary[]`), max 100
//      lines. Over budget it is truncated to exactly 100 lines and
//      git.summaryTruncated is set true; sibling git fields are untouched. WHICH
//      100 lines survive (leading vs trailing) is not documented, so only the
//      length + flag are pinned. When `git` is null, truncation is skipped and
//      compact never throws (§Size budget: "skipped when git is null").
// ---------------------------------------------------------------------------

const T0 = '2026-07-11T00:00:00.000Z';
const TRUNC_SUFFIX = '…[truncated]';

// A fresh baton/bundle@1, built as a literal (not via schema.mjs) so this file's
// red phase is attributable to compact.mjs alone.
function baseBundle() {
  return {
    schema: 'baton/bundle@1',
    bundleId: 'b_testbundle00000',
    generation: 1,
    createdAt: T0,
    updatedAt: T0,
    origin: { platform: 'claude-code', model: 'm', sessionHint: null, unstable: false },
    task: { goal: 'g', constraints: [], acceptance: [] },
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
}

// n decisions with identifiable summaries d0..d(n-1) and short details.
function decisions(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ seq: i, ts: T0, summary: `d${i}` });
  return out;
}

// n file-touch entries with strictly increasing (ISO-sortable) lastTs: f0 oldest.
function files(n) {
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ path: `f${i}.js`, op: 'edit', lastTs: new Date(start + i * 1000).toISOString() });
  }
  return out;
}

const markerFor = (n) => `[compacted: ${n} earlier decisions omitted — full log in journal.ndjson]`;

describe('compact.compact — decisions budget', () => {
  it('leaves exactly 200 decisions untouched (200 is the max, not over)', () => {
    const b = baseBundle();
    b.decisions = decisions(200);
    const out = compact(b);
    assert.equal(out.decisions.length, 200);
    assert.ok(!out.decisions.some((d) => /^\[compacted:/.test(d.summary)), 'no marker at the boundary');
    assert.equal(out.decisions[0].summary, 'd0');
    assert.equal(out.decisions[199].summary, 'd199');
  });

  it('collapses 201 decisions to first-20 + marker(N=31) + last-150 = 171', () => {
    const b = baseBundle();
    b.decisions = decisions(201);
    const out = compact(b);
    assert.equal(out.decisions.length, 171);
    assert.equal(out.decisions[0].summary, 'd0');
    assert.equal(out.decisions[19].summary, 'd19');
    assert.equal(out.decisions[20].summary, markerFor(31)); // 201 - 170 omitted
    assert.equal(out.decisions[21].summary, 'd51'); // last 150 = original indices 51..200
    assert.equal(out.decisions[170].summary, 'd200');
  });

  it('collapses 250 decisions to first-20 + marker(N=80) + last-150 = 171', () => {
    const b = baseBundle();
    b.decisions = decisions(250);
    const out = compact(b);
    assert.equal(out.decisions.length, 171);
    assert.equal(out.decisions[0].summary, 'd0');
    assert.equal(out.decisions[19].summary, 'd19');
    assert.equal(out.decisions[20].summary, markerFor(80)); // 250 - 170 omitted
    assert.equal(out.decisions[21].summary, 'd100'); // last 150 = original indices 100..249
    assert.equal(out.decisions[170].summary, 'd249');
  });

  it('marker text matches the exact documented format and carries no AI-attribution', () => {
    const b = baseBundle();
    b.decisions = decisions(250);
    const marker = compact(b).decisions[20].summary;
    assert.equal(marker, '[compacted: 80 earlier decisions omitted — full log in journal.ndjson]');
    for (const forbidden of [/claude/i, /anthropic/i, /\bAI\b/, /generated/i, /co-authored/i]) {
      assert.ok(!forbidden.test(marker), `marker must not contain ${forbidden}`);
    }
  });

  it('accumulates droppedDecisions onto the prior counter (5 + 80 = 85)', () => {
    const b = baseBundle();
    b.compaction.droppedDecisions = 5;
    b.decisions = decisions(250);
    const out = compact(b);
    assert.equal(out.compaction.droppedDecisions, 85);
  });
});

describe('compact.compact — detail cap', () => {
  it('caps an over-long detail to exactly 2000 chars ending in the truncation suffix', () => {
    const b = baseBundle();
    b.decisions = [{ seq: 0, ts: T0, summary: 'big', detail: 'x'.repeat(5000) }];
    const out = compact(b);
    const detail = out.decisions[0].detail;
    assert.equal(detail.length, 2000, 'detail must be hard-capped at 2000 chars total');
    assert.ok(detail.endsWith(TRUNC_SUFFIX), 'capped detail must end with the truncation suffix');
    assert.equal(detail, 'x'.repeat(2000 - TRUNC_SUFFIX.length) + TRUNC_SUFFIX);
  });

  it('leaves a short detail unchanged', () => {
    const b = baseBundle();
    b.decisions = [{ seq: 0, ts: T0, summary: 's', detail: 'short detail' }];
    const out = compact(b);
    assert.equal(out.decisions[0].detail, 'short detail');
  });
});

describe('compact.compact — files budget', () => {
  it('keeps the newest 300 files by lastTs, evicts the oldest, and sets files.truncated', () => {
    const b = baseBundle();
    b.files.touched = files(350);
    const out = compact(b);

    assert.equal(out.files.touched.length, 300);
    assert.equal(out.files.truncated, true);

    const paths = out.files.touched.map((e) => e.path);
    assert.ok(paths.includes('f349.js'), 'newest entry must be retained');
    assert.ok(paths.includes('f50.js'), 'oldest retained entry (newest-300 boundary)');
    assert.ok(!paths.includes('f49.js'), 'the 50 oldest entries must be evicted');
    assert.ok(!paths.includes('f0.js'), 'the oldest entry must be evicted');
  });
});

describe('compact.compact — git.dirtySummary budget', () => {
  // n identifiable lines: "line 0" .. "line n-1".
  const dirtyLines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`);

  it('truncates a >100-line dirtySummary to exactly 100 lines and sets git.summaryTruncated, leaving sibling git fields untouched', () => {
    const b = baseBundle();
    b.git = {
      branch: 'main',
      headSha: 'abc123',
      dirty: true,
      dirtySummary: dirtyLines(120),
      contentDigest: 'sha256:deadbeef',
    };
    const out = compact(b);

    assert.equal(out.git.dirtySummary.length, 100, 'dirtySummary must be capped at 100 lines');
    assert.equal(out.git.summaryTruncated, true, 'over-budget dirtySummary must set git.summaryTruncated');

    // Truncation touches only dirtySummary (+ its flag); every other git field is preserved.
    assert.equal(out.git.branch, 'main');
    assert.equal(out.git.headSha, 'abc123');
    assert.equal(out.git.dirty, true);
    assert.equal(out.git.contentDigest, 'sha256:deadbeef');
  });

  it('passes a null git through compact unchanged and never throws', () => {
    const b = baseBundle(); // git is null
    let out;
    assert.doesNotThrow(() => {
      out = compact(b);
    });
    assert.equal(out.git, null, 'a null git must remain null — dirtySummary truncation is skipped');
  });
});

describe('compact.compact — identity and determinism', () => {
  it('returns a deep-equal bundle for fully-under-budget input, without mutating it', () => {
    const b = baseBundle();
    b.decisions = decisions(3).map((d) => ({ ...d, detail: 'ok' }));
    b.files.touched = files(2);
    const snapshot = structuredClone(b);

    const out = compact(b);
    assert.deepEqual(out, snapshot, 'under-budget input must round-trip unchanged');
    assert.deepEqual(b, snapshot, 'compact must not mutate its input');
  });

  it('is deterministic: two runs on the same input produce byte-identical JSON', () => {
    const b = baseBundle();
    b.decisions = decisions(250);
    b.files.touched = files(350);
    const first = JSON.stringify(compact(b));
    const second = JSON.stringify(compact(b));
    assert.equal(first, second);
  });
});
