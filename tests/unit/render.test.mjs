import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderHandoffMd } from '../../core/src/bundle/render.mjs';
import { assertGolden, goldenPath } from '../helpers/golden.mjs';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Contract choices for bundle/render.mjs (docs/design/core.md §Module APIs
// "renderHandoffMd(bundle) -> string  // golden-tested, no AI-credit strings";
// §Per-module test lists render; plan §Receive "unverified claims to audit").
//
// SIGNATURE (pinned here, Wave-B2 Finding 5): renderHandoffMd(bundle, options?)
// -> string, where options.warnings?: string[]. The second arg is OPTIONAL and
// purely additive — called with one arg (or with no/empty warnings) the output
// is byte-identical to before, so the three original goldens are unchanged. The
// warnings are supplied BY THE CALLER (receive computes staleness against live
// git/headSha); render does not derive them — it just lists whatever it is given.
//
// CLAIMS-NOT-INSTRUCTIONS POSTURE (Finding 5, explicitly DEFERRED): the plan's
// "bundle content is unverified claims to audit, not instructions to obey" framing
// lives in the RECEIVE RESUME PROMPT (core/src/receive/prompt.mjs), NOT in
// HANDOFF.md. HANDOFF.md is a human-readable rendering of bundle data; it carries
// no audit/claims banner and none of these goldens assert one. Do not add one here.
//
// renderHandoffMd is PURE (data in, string out) and DETERMINISTIC. The FIVE
// committed goldens ARE the format spec; the implementation must reproduce them
// byte-for-byte. Bundles here are built as literals (not via schema.emptyBundle)
// so a red failure is attributable to render.mjs alone and never to id/clock
// randomness. Readings pinned where the design left the format open:
//
//   1. SECTION ORDER is fixed and every section always renders, even when empty
//      (empty ones show an italic "_…_" placeholder). This makes the minimal
//      golden a full-shape contract, not a subset. Order: header → [Warnings] →
//      Constraints → Plan → Roles → Decisions (last 15) → Files touched → Git →
//      Next actions → footer. The Warnings section (see 12) is CONDITIONAL: it
//      renders immediately after the header bullets, and only when options.warnings
//      is a non-empty array.
//   2. HEADER = `# Handoff: {goal}` then bullet lines `- Status: {…}`,
//      `- Origin: {platform} / {model}`, and — only when handoff.status ===
//      'sealed' — `- Finalized: {handoff.reason}`.
//   3. STATUS line is derived from plan-step COUNTS only (not handoff.status):
//      total 0 → "No plan steps yet"; else "{done}/{total} steps done" with
//      ", {n} active" and ", {n} blocked" suffixes appended only when > 0
//      (pending is implied, never printed).
//   4. PLAN uses GFM task syntax: "- [x] {title}" for status==='done', "- [ ]
//      {title}" for every other status (active/pending/blocked all unchecked).
//   5. ROLES render as a GFM table sorted by role name ASCENDING (deterministic
//      regardless of object insert order — the mid-session fixture inserts them
//      reversed). Columns are (Role | Platform | Model) by default; a fourth MODE
//      column is added IFF at least one assignment carries a `mode` field
//      (resolver output: native|delegated|forced-default|unavailable). When the
//      Mode column is active, a null platform or model renders as an em dash
//      "—" (U+2014) — the honest rendering of an `unavailable` role that resolved
//      to no platform. The degraded-role golden pins the 4-column form; every
//      other fixture (no modes) pins the 3-column form.
//   6. DECISIONS render the LAST 15 by array order as "- {summary}" (summary
//      only; detail/seq/ts are not shown in the markdown). The sealed fixture
//      carries 17 decisions to pin the last-15 window (Decision 3..17).
//   7. FILES render in array order as "- {op} {path}".
//   8. GIT (null → placeholder) else bullets Branch/HEAD/Dirty(yes|no); when
//      dirty AND dirtySummary is non-empty, each summary line is an indented
//      sub-bullet "  - {line}".
//   9. NEXT ACTIONS = the first 5 steps whose status is 'active' OR 'pending',
//      in array order, numbered "1. {title}" (blocked/done excluded).
//  10. FOOTER is exactly, and always, the pinned line after a "---" rule:
//      "Machine-readable data: .handoff/bundle.json (baton bundle schema v1)".
//  11. Output ends with a single trailing newline. No AI-credit/attribution
//      string ever appears — asserted below on every golden and on live output.
//      NOTE: platform/model identifiers (e.g. "claude-code", "gpt-5.6-sol") are
//      legitimate bundle DATA, not attribution; the scan targets credit PHRASES.
//  12. WARNINGS SECTION (Finding 5) — when options.warnings is a non-empty
//      array, a "## Warnings" section renders directly after the header bullets
//      (before Constraints), one "- {warning}" bullet per array element, in the
//      order given, verbatim. When warnings is absent, undefined, or empty, the
//      section is omitted entirely (no heading, no placeholder) — this is what
//      keeps the one-arg goldens byte-identical. The `stale` golden pins the
//      section's placement and format; the warning strings there come from the
//      test's STALE_WARNINGS array, so render only has to emit them verbatim.
// ---------------------------------------------------------------------------

const T0 = '2026-07-11T00:00:00.000Z';
const T1 = '2026-07-11T09:30:00.000Z';

function minimalBundle() {
  return {
    schema: 'baton/bundle@1',
    bundleId: 'b_min0000000000',
    generation: 1,
    createdAt: T0,
    updatedAt: T0,
    origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: null, unstable: false },
    task: { goal: 'Set up the project', constraints: [], acceptance: [] },
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

function midSessionBundle() {
  return {
    schema: 'baton/bundle@1',
    bundleId: 'b_mid0000000000',
    generation: 3,
    createdAt: T0,
    updatedAt: T1,
    origin: { platform: 'codex', model: 'gpt-5.6-sol', sessionHint: 'sess-1', unstable: false },
    task: {
      goal: 'Implement the bundle store layer',
      constraints: ['Zero runtime dependencies', 'Deterministic output'],
      acceptance: ['store loads survive a kill-mid-write'],
    },
    plan: {
      steps: [
        { id: 's1', title: 'Write fsx', status: 'done', note: null },
        { id: 's2', title: 'Write store', status: 'active', note: 'in progress' },
        { id: 's3', title: 'Write render', status: 'pending', note: null },
        { id: 's4', title: 'Write lock', status: 'pending', note: null },
        { id: 's5', title: 'Wire CLI', status: 'blocked', note: 'awaiting review' },
      ],
    },
    decisions: [
      { seq: 1, ts: T0, summary: 'Chose tmp+rename for atomic writes' },
      { seq: 2, ts: T0, summary: 'Journal is append-only NDJSON' },
      { seq: 3, ts: T1, summary: 'Recovery prefers .bak then journal rebuild' },
    ],
    files: {
      touched: [
        { path: 'core/src/util/fsx.mjs', op: 'create', lastTs: T0 },
        { path: 'core/src/bundle/store.mjs', op: 'edit', lastTs: T1 },
      ],
    },
    // Inserted reversed on purpose: the renderer MUST sort rows alphabetically.
    roles: {
      assignments: {
        'test-author': { platform: 'claude-code', model: 'claude-opus-4-8' },
        implementer: { platform: 'claude-code', model: 'claude-fable-5' },
      },
    },
    git: {
      branch: 'main',
      headSha: 'a1b2c3d',
      dirty: true,
      dirtySummary: ['M core/src/bundle/store.mjs', '?? tests/unit/store.test.mjs'],
      contentDigest: 'deadbeefcafe',
      summaryTruncated: false,
    },
    handoff: {
      status: 'open',
      reason: null,
      reasonClass: null,
      toPlatformHint: null,
      finalizedAt: null,
      receive_log: [],
    },
    journalSeq: 42,
    compaction: { droppedDecisions: 0, note: null },
    dedupeRing: [],
  };
}

function sealedBundle() {
  const decisions = [];
  for (let n = 1; n <= 17; n += 1) decisions.push({ seq: n, ts: T0, summary: `Decision ${n}` });
  return {
    schema: 'baton/bundle@1',
    bundleId: 'b_sealed00000000',
    generation: 1,
    createdAt: T0,
    updatedAt: T1,
    origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: 'sess-9', unstable: false },
    task: { goal: 'Ship failover v1', constraints: ['Deterministic and explainable output'], acceptance: [] },
    plan: {
      steps: [
        { id: 'a', title: 'Build core', status: 'done', note: null },
        { id: 'b', title: 'Build adapters', status: 'done', note: null },
      ],
    },
    decisions,
    files: { touched: [{ path: 'README.md', op: 'edit', lastTs: T1 }] },
    roles: { assignments: {} },
    git: { branch: 'main', headSha: 'ffff000', dirty: false, dirtySummary: [], contentDigest: '00', summaryTruncated: false },
    handoff: {
      status: 'sealed',
      reason: "You've hit your usage limit",
      reasonClass: 'usage-limit',
      toPlatformHint: 'codex',
      finalizedAt: T1,
      receive_log: [],
    },
    journalSeq: 8,
    compaction: { droppedDecisions: 0, note: null },
    dedupeRing: [],
  };
}

// Stale bundle: git/headSha context implies staleness. The warnings themselves
// are supplied by the caller (receive), modeled here by STALE_WARNINGS and passed
// as the second arg. These exact strings are reproduced in the `stale` golden.
const STALE_WARNINGS = [
  'Bundle finalized 14h ago (staleness threshold 12h) — re-verify before continuing.',
  'HEAD moved since capture: bundle recorded a1b2c3d, working tree now e5f6a7b.',
  'Working tree is dirty; captured file state may not match what is on disk.',
];

function staleBundle() {
  return {
    schema: 'baton/bundle@1',
    bundleId: 'b_stale00000000',
    generation: 2,
    createdAt: T0,
    updatedAt: T1,
    origin: { platform: 'codex', model: 'gpt-5.6-sol', sessionHint: 'sess-stale', unstable: false },
    task: { goal: 'Wire the receive transaction', constraints: ['Deterministic output'], acceptance: [] },
    plan: {
      steps: [
        { id: 's1', title: 'Draft prepare/commit', status: 'done', note: null },
        { id: 's2', title: 'Bind receipt token', status: 'active', note: null },
      ],
    },
    decisions: [{ seq: 1, ts: T0, summary: 'Token binds journalSeq + git digest' }],
    files: { touched: [{ path: 'core/src/receive/prompt.mjs', op: 'edit', lastTs: T1 }] },
    roles: { assignments: {} },
    git: {
      branch: 'main',
      headSha: 'a1b2c3d',
      dirty: true,
      dirtySummary: ['M core/src/receive/prompt.mjs'],
      contentDigest: 'cafebabe',
      summaryTruncated: false,
    },
    handoff: {
      status: 'sealed',
      reason: "You've hit your usage limit",
      reasonClass: 'usage-limit',
      toPlatformHint: 'claude-code',
      finalizedAt: T0,
      receive_log: [],
    },
    journalSeq: 12,
    compaction: { droppedDecisions: 0, note: null },
    dedupeRing: [],
  };
}

// Degraded-role bundle: role assignments carry a `mode`, so the Roles table gains
// the Mode column. Inserted out of alpha order on purpose; the renderer sorts.
// The `unavailable` role resolved to no platform/model (both null → em dash).
function degradedRoleBundle() {
  return {
    schema: 'baton/bundle@1',
    bundleId: 'b_degrade000000',
    generation: 1,
    createdAt: T0,
    updatedAt: T1,
    origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: 'sess-dg', unstable: false },
    task: { goal: 'Resolve roles under single-vendor availability', constraints: [], acceptance: [] },
    plan: { steps: [{ id: 's1', title: 'Probe platforms', status: 'done', note: null }] },
    decisions: [],
    files: { touched: [] },
    roles: {
      assignments: {
        'test-verifier': { platform: null, model: null, mode: 'unavailable' },
        implementer: { platform: 'claude-code', model: 'claude-fable-5', mode: 'native' },
        'plan-reviewer': { platform: 'codex', model: 'gpt-5.6-sol', mode: 'forced-default' },
      },
    },
    git: null,
    handoff: {
      status: 'open',
      reason: null,
      reasonClass: null,
      toPlatformHint: null,
      finalizedAt: null,
      receive_log: [],
    },
    journalSeq: 3,
    compaction: { droppedDecisions: 0, note: null },
    dedupeRing: [],
  };
}

// Attribution / AI-credit PHRASES. Deliberately narrow so it never trips on
// legitimate platform/model identifiers ("claude-code", "gpt-5.6-sol") that are
// real bundle data. These are the strings the zero-attribution invariant bans.
const ATTRIBUTION_PATTERNS = [
  /co-authored-by/i,
  /generated with claude/i,
  /generated by claude/i,
  /🤖/,
  /written by (an? )?ai\b/i,
  /authored by (an? )?ai\b/i,
  /powered by claude/i,
];

function scanAttribution(text) {
  return ATTRIBUTION_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
}

describe('render.renderHandoffMd — goldens', () => {
  it('minimal (fresh empty bundle) renders the pinned format', () => {
    assertGolden('minimal', renderHandoffMd(minimalBundle()));
  });

  it('mid-session (mixed step statuses, decisions, files, roles, git) renders the pinned format', () => {
    assertGolden('mid-session', renderHandoffMd(midSessionBundle()));
  });

  it('sealed (finalized, usage-limit reason, >15 decisions) renders the pinned format', () => {
    assertGolden('sealed', renderHandoffMd(sealedBundle()));
  });

  it('stale (git/headSha implies staleness) renders a Warnings section from the warnings arg', () => {
    assertGolden('stale', renderHandoffMd(staleBundle(), { warnings: STALE_WARNINGS }));
  });

  it('degraded-role (forced-default + unavailable) renders the Roles table with a Mode column', () => {
    assertGolden('degraded-role', renderHandoffMd(degradedRoleBundle()));
  });
});

describe('render.renderHandoffMd — structural rules', () => {
  it('sections appear exactly once and in the fixed order', () => {
    const md = renderHandoffMd(midSessionBundle());
    const headings = ['## Constraints', '## Plan', '## Roles', '## Decisions (last 15)', '## Files touched', '## Git', '## Next actions'];
    let cursor = -1;
    for (const h of headings) {
      const at = md.indexOf(h);
      assert.notEqual(at, -1, `missing section heading ${h}`);
      assert.equal(md.indexOf(h, at + 1), -1, `section heading ${h} appears more than once`);
      assert.ok(at > cursor, `section ${h} is out of order`);
      cursor = at;
    }
  });

  it('header derives the one-line status from plan-step counts', () => {
    assert.match(renderHandoffMd(minimalBundle()), /^- Status: No plan steps yet$/m);
    assert.match(renderHandoffMd(midSessionBundle()), /^- Status: 1\/5 steps done, 1 active, 1 blocked$/m);
    assert.match(renderHandoffMd(sealedBundle()), /^- Status: 2\/2 steps done$/m);
  });

  it('adds a Finalized line with the reason only when the bundle is sealed', () => {
    assert.match(renderHandoffMd(sealedBundle()), /^- Finalized: You've hit your usage limit$/m);
    assert.doesNotMatch(renderHandoffMd(minimalBundle()), /^- Finalized:/m);
    assert.doesNotMatch(renderHandoffMd(midSessionBundle()), /^- Finalized:/m);
  });

  it('renders the plan checklist with [x] for done and [ ] for everything else', () => {
    const md = renderHandoffMd(midSessionBundle());
    assert.match(md, /^- \[x\] Write fsx$/m);
    assert.match(md, /^- \[ \] Write store$/m); // active is unchecked
    assert.match(md, /^- \[ \] Wire CLI$/m); // blocked is unchecked
  });

  it('sorts the roles table alphabetically regardless of object insertion order', () => {
    const md = renderHandoffMd(midSessionBundle());
    const impAt = md.indexOf('| implementer |');
    const taAt = md.indexOf('| test-author |');
    assert.ok(impAt !== -1 && taAt !== -1, 'both role rows must render');
    assert.ok(impAt < taAt, 'implementer must sort before test-author even though it was inserted second');
  });

  it('adds a Mode column only when a role assignment carries a mode', () => {
    // No assignment carries a mode → 3-column table, no Mode header.
    assert.doesNotMatch(renderHandoffMd(midSessionBundle()), /\| Mode \|/);
    // At least one assignment carries a mode → 4-column table with Mode.
    const dg = renderHandoffMd(degradedRoleBundle());
    assert.match(dg, /^\| Role \| Platform \| Model \| Mode \|$/m);
    assert.match(dg, /^\| implementer \| claude-code \| claude-fable-5 \| native \|$/m);
    assert.match(dg, /^\| plan-reviewer \| codex \| gpt-5\.6-sol \| forced-default \|$/m);
    assert.match(dg, /^\| test-verifier \| — \| — \| unavailable \|$/m, 'null platform/model render as em dashes');
  });

  it('renders a Warnings section only when non-empty warnings are supplied, placed after the header', () => {
    assert.doesNotMatch(renderHandoffMd(minimalBundle()), /## Warnings/, 'no warnings arg → no section');
    assert.doesNotMatch(renderHandoffMd(minimalBundle(), {}), /## Warnings/, 'no warnings key → no section');
    assert.doesNotMatch(renderHandoffMd(minimalBundle(), { warnings: [] }), /## Warnings/, 'empty warnings → no section');

    const md = renderHandoffMd(minimalBundle(), { warnings: ['Bundle is stale', 'HEAD moved'] });
    assert.match(md, /^## Warnings$/m);
    assert.match(md, /^- Bundle is stale$/m);
    assert.match(md, /^- HEAD moved$/m);
    // Placement: after the header/status bullets, before Constraints.
    assert.ok(md.indexOf('## Warnings') < md.indexOf('## Constraints'), 'Warnings precedes Constraints');
    assert.ok(md.indexOf('- Origin:') < md.indexOf('## Warnings'), 'Warnings follows the header bullets');
  });

  it('shows only the last 15 decisions in array order', () => {
    const md = renderHandoffMd(sealedBundle());
    assert.doesNotMatch(md, /^- Decision 2$/m, 'the 16th-from-last decision must be dropped');
    assert.match(md, /^- Decision 3$/m, 'the 15th-from-last decision must be the first shown');
    assert.match(md, /^- Decision 17$/m, 'the most recent decision must be shown');
    const shown = [...md.matchAll(/^- Decision (\d+)$/gm)].map((m) => Number(m[1]));
    assert.equal(shown.length, 15);
    assert.deepEqual(shown, Array.from({ length: 15 }, (_v, i) => i + 3));
  });

  it('lists next actions as the top-5 active/pending steps, excluding done and blocked', () => {
    const md = renderHandoffMd(midSessionBundle());
    assert.match(md, /^1\. Write store$/m); // active
    assert.match(md, /^2\. Write render$/m); // pending
    assert.match(md, /^3\. Write lock$/m); // pending
    assert.doesNotMatch(md, /^\d+\. Wire CLI$/m); // blocked excluded from the numbered list
    assert.doesNotMatch(md, /^\d+\. Write fsx$/m); // done excluded
  });

  it('renders git dirty summary lines as indented sub-bullets, and "no" without them when clean', () => {
    const dirty = renderHandoffMd(midSessionBundle());
    assert.match(dirty, /^- Dirty: yes$/m);
    assert.match(dirty, /^ {2}- M core\/src\/bundle\/store\.mjs$/m);
    const clean = renderHandoffMd(sealedBundle());
    assert.match(clean, /^- Dirty: no$/m);
    assert.doesNotMatch(clean, /^ {2}- /m); // no sub-bullets when clean
  });

  it('always ends with the exact machine-readable footer and a single trailing newline', () => {
    for (const b of [minimalBundle(), midSessionBundle(), sealedBundle()]) {
      const md = renderHandoffMd(b);
      assert.ok(
        md.endsWith('Machine-readable data: .handoff/bundle.json (baton bundle schema v1)\n'),
        'output must end with the pinned footer line + newline',
      );
      assert.ok(!md.endsWith('\n\n'), 'exactly one trailing newline');
    }
  });
});

describe('render.renderHandoffMd — determinism and purity', () => {
  it('is byte-identical across repeated calls', () => {
    for (const make of [minimalBundle, midSessionBundle, sealedBundle, degradedRoleBundle]) {
      assert.equal(renderHandoffMd(make()), renderHandoffMd(make()));
    }
    assert.equal(
      renderHandoffMd(staleBundle(), { warnings: STALE_WARNINGS }),
      renderHandoffMd(staleBundle(), { warnings: STALE_WARNINGS }),
    );
  });

  it('does not mutate its input bundle or the warnings array', () => {
    for (const make of [midSessionBundle, degradedRoleBundle]) {
      const b = make();
      const snapshot = structuredClone(b);
      renderHandoffMd(b);
      assert.deepEqual(b, snapshot);
    }
    const sb = staleBundle();
    const bundleSnapshot = structuredClone(sb);
    const warnings = [...STALE_WARNINGS];
    renderHandoffMd(sb, { warnings });
    assert.deepEqual(sb, bundleSnapshot, 'the bundle is not mutated even with warnings');
    assert.deepEqual(warnings, STALE_WARNINGS, 'the warnings array is not mutated');
  });
});

describe('render — zero AI-attribution invariant', () => {
  it('none of the committed goldens contain an attribution/credit string', () => {
    for (const name of ['minimal', 'mid-session', 'sealed', 'stale', 'degraded-role']) {
      const text = readFileSync(goldenPath(name), 'utf8');
      assert.deepEqual(scanAttribution(text), [], `golden "${name}" must contain no attribution strings`);
    }
  });

  it('live renderer output contains no attribution/credit string', () => {
    const outputs = [
      renderHandoffMd(minimalBundle()),
      renderHandoffMd(midSessionBundle()),
      renderHandoffMd(sealedBundle()),
      renderHandoffMd(staleBundle(), { warnings: STALE_WARNINGS }),
      renderHandoffMd(degradedRoleBundle()),
    ];
    for (const md of outputs) assert.deepEqual(scanAttribution(md), []);
  });

  it('positive control: the scanner actually flags a known attribution string', () => {
    // Guards against a vacuously-passing scan: these MUST be caught.
    assert.ok(scanAttribution('Co-Authored-By: Claude <noreply@anthropic.com>').length > 0);
    assert.ok(scanAttribution('🤖 Generated with Claude Code').length > 0);
  });
});
