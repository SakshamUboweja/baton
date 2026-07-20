import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classify, transcriptTail } from '../../core/src/detect/classifier.mjs';
import { loadSignatures } from '../../core/src/detect/signatures.mjs';

// ---------------------------------------------------------------------------
// RED — loop child supervision, PURE parts (subtask loop-children, part A).
// NEW module; these tests DEFINE the API. Source of truth:
// docs/plans/2026-07-18-goal-loop-worktree-pipeline.md §"Child supervision
// contract" + §"baton loop (Layer 2)" child bullets; AGENTS.md §9 (sole-author
// attribution). This is the reliability surface — every pin is a field-failure
// class (stdin-hang, prompt-echo, zombie grandchild, unparseable-as-APPROVED).
//
// TARGET MODULE: core/src/loop/children.mjs.
//
// PINNED EXPORTS (the implementer follows these names):
//   buildChildArgv(assignment, prompt, opts) -> {command, args, env, stdio}
//   parseVerdict(transcript, {platform})     -> {verdict, findings, reason?}
//   (capLog removed — N4: superviseChild streams inline; the export is dead)
//   classifyChildExit(transcript, exitCode, platform, table) -> class string
//   superviseChild(spec, opts)               -> Promise<result> (integration file)
//
// RED MECHANISM: dynamic-import-with-catch + M() guard (meaningful reds).
// ---------------------------------------------------------------------------

let mod = /** @type {any} */ (null);
let importError = /** @type {any} */ (null);
try {
  mod = await import('../../core/src/loop/children.mjs');
} catch (e) {
  importError = e;
}
function M() {
  assert.ok(mod, `core/src/loop/children.mjs must load (import error: ${importError?.message ?? 'none'})`);
  return mod;
}

// Resolver-shaped assignment (mirrors roles/resolve.mjs output + the role id).
const asg = (platform, role, model, effort = null) => ({ platform, role, model, effort, mode: platform === 'codex' ? 'native' : 'delegated' });

// The full read-only review seat set (must ALL be read-only on both platforms —
// final-reviewer-b included; verifier iter-2 finding).
const REVIEWER_ROLES = ['plan-reviewer', 'test-verifier', 'subtask-reviewer', 'final-reviewer-a', 'final-reviewer-b'];

const valAfter = (/** @type {string[]} */ args, /** @type {string} */ flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
// A claude child is READ-ONLY only if EVERY allowed tool is in the known
// read-only set — Read/Grep/Glob or a scoped read-only git command
// (`Bash(git diff:*)` / `log` / `show` / `status`). Anything else (acceptEdits,
// Write/Edit, a bare or non-git Bash, an unknown tool, or a missing allowlist)
// is treated as WRITE-CAPABLE. Fail CLOSED (verifier finding 8): an unrecognized
// grant must never be assumed safe.
const READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const READONLY_GIT_BASH = /^Bash\(git (diff|log|show|status)[):]/;
const claudeGrantsWrite = (/** @type {string[]} */ args) => {
  if (valAfter(args, '--permission-mode') === 'acceptEdits') return true;
  const tools = valAfter(args, '--allowedTools');
  if (typeof tools !== 'string') return true; // no explicit allowlist ⇒ not provably read-only
  const entries = tools.split(',').map((t) => t.trim()).filter(Boolean);
  if (entries.length === 0) return true;
  return entries.some((t) => !READONLY_TOOLS.has(t) && !READONLY_GIT_BASH.test(t));
};

// ===========================================================================
describe('buildChildArgv — claude-code roles', () => {
  it('an implementer gets claude -p with edit permission (write-capable)', () => {
    const { buildChildArgv } = M();
    const r = buildChildArgv(asg('claude-code', 'implementer', 'claude-fable-5'), 'PROMPT-TEXT', { root: '/repo' });
    assert.equal(r.command, 'claude');
    assert.ok(r.args.includes('-p'), 'headless -p mode');
    assert.ok(r.args.includes('PROMPT-TEXT'), 'the prompt is passed');
    assert.equal(claudeGrantsWrite(r.args), true, 'the implementer child may edit');
  });

  it('EVERY reviewer role gets a READ-ONLY tool grant (no acceptEdits / write tools)', () => {
    const { buildChildArgv } = M();
    for (const role of REVIEWER_ROLES) {
      const r = buildChildArgv(asg('claude-code', role, 'claude-fable-5'), 'P', { root: '/repo' });
      assert.equal(claudeGrantsWrite(r.args), false, `${role} must be read-only (no acceptEdits / write permission)`);
    }
  });

  // G1 (A1/B1/B2): a claude child that never carries the resolved model, never
  // requests a structured result, and never sets its cwd is unusable in
  // production — the role matrix is voided, parseVerdict reads BLOCKED-unparseable,
  // and the child spawns in the supervisor cwd (breaking seat isolation).
  it('RED (G1): claude argv passes the resolved --model (the role matrix / entry avoidance is honored)', () => {
    const { buildChildArgv } = M();
    const r = buildChildArgv(asg('claude-code', 'implementer', 'claude-opus-4-8'), 'P', { root: '/repo' });
    assert.equal(valAfter(r.args, '--model'), 'claude-opus-4-8', 'the resolved model reaches the claude child');
  });

  it('RED (G1): claude argv requests --output-format json (parseVerdict reads the structured result)', () => {
    const { buildChildArgv } = M();
    const r = buildChildArgv(asg('claude-code', 'implementer', 'claude-fable-5'), 'P', { root: '/repo' });
    assert.equal(valAfter(r.args, '--output-format'), 'json', 'claude emits a structured result the verdict parser can read');
  });

  it('RED (G1): the spawn spec carries the child cwd = opts.root (the child runs in its seat, not the supervisor cwd)', () => {
    const { buildChildArgv } = M();
    const cc = buildChildArgv(asg('claude-code', 'implementer', 'claude-fable-5'), 'P', { root: '/repo/.worktrees/wt-a' });
    assert.equal(cc.cwd, '/repo/.worktrees/wt-a', 'the claude spawn spec expresses its cwd so superviseChild runs it in the seat');
    const cx = buildChildArgv(asg('codex', 'implementer', 'gpt-5.6-sol', 'xhigh'), 'P', { root: '/repo/.worktrees/wt-b' });
    assert.equal(cx.cwd, '/repo/.worktrees/wt-b', 'the codex spawn spec carries the same cwd field');
  });

  // G5 (A5/B5): a claude read-only reviewer with only Read,Grep,Glob cannot run
  // `git diff` — it is blind to the change it must review. The reviewer allowlist
  // gains scoped read-only git, still WITHOUT general write tools.
  it('RED (G5): a claude reviewer allowlist includes scoped read-only git (diff/log/show), no general write tools', () => {
    const { buildChildArgv } = M();
    const r = buildChildArgv(asg('claude-code', 'subtask-reviewer', 'claude-fable-5'), 'P', { root: '/repo' });
    const tools = valAfter(r.args, '--allowedTools') ?? '';
    assert.match(tools, /Bash\(git diff[):]/, 'the reviewer can run git diff');
    assert.match(tools, /Bash\(git (log|show)[):]/, 'the reviewer can inspect history');
    assert.doesNotMatch(tools, /\bWrite\b|\bEdit\b/, 'no Write/Edit in a reviewer allowlist');
    assert.equal(claudeGrantsWrite(r.args), false, 'scoped git reads keep the reviewer read-only');
  });
});

// ===========================================================================
describe('buildChildArgv — codex roles', () => {
  it('an implementer gets codex exec with a WRITE sandbox, model + effort, root, prompt', () => {
    const { buildChildArgv } = M();
    const r = buildChildArgv(asg('codex', 'implementer', 'gpt-5.6-sol', 'xhigh'), 'PROMPT-TEXT', { root: '/repo' });
    assert.equal(r.command, 'codex');
    assert.ok(r.args.includes('exec'));
    assert.equal(valAfter(r.args, '-C'), '/repo', 'the working root is passed with -C');
    assert.equal(valAfter(r.args, '--model'), 'gpt-5.6-sol');
    assert.ok(r.args.includes('-c') && r.args.includes('model_reasoning_effort=xhigh'), 'effort is passed via -c');
    assert.ok(r.args.includes('PROMPT-TEXT'));
    assert.match(String(valAfter(r.args, '-s')), /write/, 'implementer runs in a write sandbox');
  });

  it('EVERY reviewer role runs codex in a READ-ONLY sandbox', () => {
    const { buildChildArgv } = M();
    for (const role of REVIEWER_ROLES) {
      const r = buildChildArgv(asg('codex', role, 'gpt-5.6-sol', 'xhigh'), 'P', { root: '/repo' });
      assert.equal(valAfter(r.args, '-s'), 'read-only', `${role} gets the read-only sandbox`);
    }
  });
});

// ===========================================================================
// D2 (dogfood milestone C) — a codex WRITE-capable child in a LINKED worktree
// cannot commit unless the MAIN repo's .git dir is an extra sandbox writable
// root: a linked worktree's index/lock lives under <mainRoot>/.git/worktrees/
// <seat>, OUTSIDE the seat-cwd sandbox (live child 002: "sandbox only has read
// access to .git/worktrees/wt-a/index.lock"). The caller passes the main .git
// path via opts.gitDir; buildChildArgv adds it to sandbox_workspace_write.
// writable_roots for write-capable codex children only.
describe('buildChildArgv — codex write children get the main .git as an extra writable root (D2)', () => {
  // Collect every value that follows a `-c` flag (codex config args).
  const configArgs = (/** @type {string[]} */ args) =>
    args.map((a, i) => (a === '-c' ? args[i + 1] : null)).filter((v) => typeof v === 'string');
  const writableRootsArg = (/** @type {string[]} */ args) =>
    configArgs(args).find((v) => /sandbox_workspace_write\.writable_roots/.test(String(v)));

  it('RED (D2): a WRITE-capable codex child adds the passed main .git dir to sandbox_workspace_write.writable_roots', () => {
    const { buildChildArgv } = M();
    // The seat cwd is a linked worktree; the main repo .git is elsewhere.
    const r = buildChildArgv(
      asg('codex', 'implementer', 'gpt-5.6-sol', 'xhigh'),
      'P',
      { root: '/repo/.worktrees/wt-a', gitDir: '/repo/.git' },
    );
    assert.equal(valAfter(r.args, '-s'), 'workspace-write', 'precondition: the implementer is write-capable');
    const wr = writableRootsArg(r.args);
    assert.ok(wr, 'a -c sandbox_workspace_write.writable_roots config arg is present for a write child with a gitDir');
    assert.match(String(wr), /\/repo\/\.git/, 'the writable_roots names the MAIN repo .git dir (where the linked worktree index/lock live)');
  });

  it('GUARD (D2): a READ-ONLY codex child gets NO extra writable root, even when a gitDir is passed', () => {
    const { buildChildArgv } = M();
    for (const role of REVIEWER_ROLES) {
      const r = buildChildArgv(asg('codex', role, 'gpt-5.6-sol', 'xhigh'), 'P', { root: '/repo/.worktrees/wt-b', gitDir: '/repo/.git' });
      assert.equal(valAfter(r.args, '-s'), 'read-only', `${role} stays read-only`);
      assert.equal(writableRootsArg(r.args), undefined, `${role} never receives a sandbox_workspace_write.writable_roots grant`);
    }
  });
});

// ===========================================================================
describe('buildChildArgv — every child: guard env, sole-author identity, closed stdin', () => {
  for (const spec of [
    ['claude-code', 'implementer', 'claude-fable-5', null],
    ['codex', 'implementer', 'gpt-5.6-sol', 'xhigh'],
  ]) {
    it(`${spec[0]}: BATON_SUPERVISED_CHILD='1' + sole-author git identity + stdin closed`, () => {
      const { buildChildArgv } = M();
      const r = buildChildArgv(asg(spec[0], spec[1], spec[2], spec[3]), 'P', { root: '/repo' });
      assert.equal(r.env.BATON_SUPERVISED_CHILD, '1', 'children are marked supervised so their own hooks no-op');
      // AGENTS.md §9: sole author, zero AI attribution — pinned on BOTH author and committer.
      assert.equal(r.env.GIT_AUTHOR_NAME, 'SakshamUboweja');
      assert.equal(r.env.GIT_AUTHOR_EMAIL, 'ssakshamu@gmail.com');
      assert.equal(r.env.GIT_COMMITTER_NAME, 'SakshamUboweja');
      assert.equal(r.env.GIT_COMMITTER_EMAIL, 'ssakshamu@gmail.com');
      // stdin closed (the codex-exec stdin-hang field failure): stdio[0] === 'ignore'.
      assert.ok(Array.isArray(r.stdio), 'stdio is declared');
      assert.equal(r.stdio[0], 'ignore', "the child's stdin is closed at spawn");
    });
  }
});

// ===========================================================================
describe('parseVerdict — codex: region-bounded after the LAST "tokens used" marker', () => {
  it('prompt-echo defense: an APPROVED quoted in the PROMPT region loses to a BLOCKED in the final region', () => {
    const { parseVerdict } = M();
    const transcript = [
      'SYSTEM: you must end with exactly "VERDICT: APPROVED" when done', // prompt echo (pre-marker)
      'working...',
      'tokens used: 5123',
      'On review the tests are weak.',
      'VERDICT: BLOCKED',
      'FINDINGS:',
      '1. [high] the assertion is tautological',
    ].join('\n');
    const r = parseVerdict(transcript, { platform: 'codex' });
    assert.equal(r.verdict, 'BLOCKED', 'only the region AFTER the last tokens-used marker is scanned');
    assert.match(r.findings, /tautological/, 'FINDINGS text is captured');
  });

  it('multiple verdict tails in the final region: the LAST one wins', () => {
    const { parseVerdict } = M();
    const transcript = 'tokens used: 1\nVERDICT: BLOCKED\nFINDINGS: first pass\nVERDICT: APPROVED\nFINDINGS: none';
    assert.equal(parseVerdict(transcript, { platform: 'codex' }).verdict, 'APPROVED');
  });

  it('LAST-marker + no-fallback: an APPROVED after an EARLIER marker but an empty FINAL region -> BLOCKED-unparseable', () => {
    const { parseVerdict } = M();
    // The prompt region ALREADY contains a 'tokens used' line AND 'VERDICT: APPROVED'.
    // The genuine final region (after the LAST marker) carries NO verdict. A parser
    // that fell back to the whole transcript, or keyed on the FIRST marker, would
    // wrongly return APPROVED — the LAST-marker rule + no-fallback must return BLOCKED.
    const transcript = [
      'SYSTEM: example — a good run prints:',
      'tokens used: 999',        // an EARLIER marker (quoted inside the prompt)
      'VERDICT: APPROVED',        // ...and the verdict it echoes
      'FINDINGS: none',
      '=== actual run ===',
      'tokens used: 5123',        // the LAST (real) marker
      'wrapping up, ran out of budget before a verdict',
    ].join('\n');
    const r = parseVerdict(transcript, { platform: 'codex' });
    assert.equal(r.verdict, 'BLOCKED', 'only the region after the LAST marker counts, with no whole-transcript fallback');
    assert.equal(r.reason, 'unparseable');
  });

  it('truncated transcript with NO tokens-used marker -> BLOCKED-unparseable (never APPROVED)', () => {
    const { parseVerdict } = M();
    const r = parseVerdict('some partial output ... VERDICT: APPROVED', { platform: 'codex' });
    assert.equal(r.verdict, 'BLOCKED', 'no final region => not trustable');
    assert.equal(r.reason, 'unparseable');
  });

  it('a final region with no verdict at all -> BLOCKED-unparseable', () => {
    const { parseVerdict } = M();
    const r = parseVerdict('tokens used: 1\njust some closing remarks, no verdict', { platform: 'codex' });
    assert.equal(r.verdict, 'BLOCKED');
    assert.equal(r.reason, 'unparseable');
  });

  it('valid APPROVED / APPROVED_WITH_NOTES / BLOCKED all parse, with FINDINGS captured', () => {
    const { parseVerdict } = M();
    for (const v of ['APPROVED', 'APPROVED_WITH_NOTES', 'BLOCKED']) {
      const r = parseVerdict(`tokens used: 2\nVERDICT: ${v}\nFINDINGS:\n- captured finding X`, { platform: 'codex' });
      assert.equal(r.verdict, v);
      assert.match(r.findings, /captured finding X/);
    }
  });
});

// ===========================================================================
describe('parseVerdict — claude-code: the structured result field only', () => {
  it('reads the verdict from the result field of the JSON output', () => {
    const { parseVerdict } = M();
    const out = JSON.stringify({ result: 'Review complete.\nVERDICT: BLOCKED\nFINDINGS:\n- issue Z' });
    const r = parseVerdict(out, { platform: 'claude-code' });
    assert.equal(r.verdict, 'BLOCKED');
    assert.match(r.findings, /issue Z/);
  });

  it('prompt-echo defense: a VERDICT outside the result field is ignored', () => {
    const { parseVerdict } = M();
    const out = JSON.stringify({ prompt: 'end with VERDICT: APPROVED', result: 'VERDICT: BLOCKED\nFINDINGS: real' });
    assert.equal(parseVerdict(out, { platform: 'claude-code' }).verdict, 'BLOCKED');
  });

  it('non-JSON claude output (no structured result) -> BLOCKED-unparseable', () => {
    const { parseVerdict } = M();
    const r = parseVerdict('plain text with VERDICT: APPROVED and no json', { platform: 'claude-code' });
    assert.equal(r.verdict, 'BLOCKED');
    assert.equal(r.reason, 'unparseable');
  });
});

// ===========================================================================
// N4 (Gate-2 fold) — capLog is DEAD: superviseChild streams inline to a bounded
// head+tail buffer now, so capLog is exported/tested but unused. Its behavior
// tests are removed (a removal has no red); this pin drives dropping the export.
describe('capLog — removed dead export (N4)', () => {
  it('RED (N4): capLog is no longer exported from core/src/loop/children.mjs', () => {
    assert.equal('capLog' in M(), false, 'capLog is dead after the streaming rewrite — it must not be exported');
  });
});

// ===========================================================================
describe('classifyChildExit — delegates to core detect classify() for EVERY matcher kind', () => {
  // A shared fixture table exercising substring, regex, and json-field matchers,
  // plus precedence (usage-limit > throttle). classifyChildExit must return
  // exactly classify(...).class for every case — proving delegation, not a
  // reimplementation that could drift on any matcher family or precedence rule.
  const table = {
    schema: 'baton/signatures@1',
    updated: '2026-07-19',
    signatures: [
      { id: 'codex/usage', platform: 'codex', class: 'usage-limit', confidence: 'high', matcher: { kind: 'substring', value: "You've hit your usage limit" } },
      { id: 'cc/model-limit', platform: 'claude-code', class: 'usage-limit', confidence: 'medium', matcher: { kind: 'regex', pattern: "You've hit your \\S+ limit" } },
      { id: 'cc/throttle', platform: 'claude-code', class: 'throttle', confidence: 'high', matcher: { kind: 'substring', value: 'Server is temporarily limiting requests' } },
      { id: 'cursor/too-many', platform: 'cursor', class: 'throttle', confidence: 'medium', matcher: { kind: 'json-field', path: 'error', equals: 'Too Many Requests' } },
    ],
  };

  const CASES = [
    ['substring match (codex usage-limit)', "You've hit your usage limit. Try again at 6PM.", 0, 'codex'],
    ['regex match (claude-code model-limit)', "You've hit your Opus limit", 0, 'claude-code'],
    ['json-field match (cursor throttle)', '{"error":"Too Many Requests"}', 1, 'cursor'],
    ['precedence: usage-limit + throttle both match -> usage-limit', "Server is temporarily limiting requests — also You've hit your Opus limit", 0, 'claude-code'],
    ['platform mismatch: a codex string under claude-code does not fire', "You've hit your usage limit", 0, 'claude-code'],
    ['generic nonzero exit, no evidence -> other-error', 'Error: build failed with 3 errors', 1, 'codex'],
    ['clean zero exit, no evidence -> ok', 'all good, nothing to report', 0, 'codex'],
  ];

  for (const [label, text, exitCode, platform] of CASES) {
    it(`${label} — classifyChildExit === classify().class`, () => {
      const { classifyChildExit } = M();
      const expected = classify({ text, exitCode, platform, table }).class;
      assert.equal(classifyChildExit(text, exitCode, platform, table), expected, `must equal core classify() for: ${label}`);
    });
  }
});

// ===========================================================================
// ITEM 7 (v1.1) — live codex marker fixture.
// tests/fixtures/codex-live-child.transcript.txt (a non-ignored extension — the
// repo gitignores *.log) is a ~16 KB TAIL SLICE of a live gpt-5.5
// supervised-writer transcript — the
// last chunk of genuine body, the real "tokens used" marker line, and the
// verbatim verdict tail. It pins parseVerdict's region parse and the D1 tail-only
// classification against reality (regression protection against marker drift).
// Provenance: a real attempt-3 pipeline dogfood child log (2026-07-20),
// trimmed to a tail slice so the tracked surface is small and hand-verifiable —
// plain build/test/README-editing chatter, no tokens/keys/personal data beyond
// the repo's own paths. ONE alteration: the pre-marker body verdict block was
// changed to a distinct decoy (VERDICT: BLOCKED / "decoy-before-marker — must
// never be parsed") for region-bounding teeth; the 'tokens used' marker line and
// the post-marker verdict tail are VERBATIM from the live transcript. These pin
// REALITY (not a new feature): GREEN pins today.
const LIVE_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'codex-live-child.transcript.txt');
const liveTranscript = readFileSync(LIVE_FIXTURE, 'utf8');
// The SHIPPED signature table — the exact one the loop/pipeline supervisor uses,
// so 7-2 pins reality against the real signatures, not a toy fixture.
const SHIPPED_SIGNATURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'data', 'signatures.v1.json');
const shippedTable = loadSignatures({ builtinPath: SHIPPED_SIGNATURES }, { fs: { readFileSync, existsSync } });

describe('parseVerdict + classify — LIVE codex transcript fixture (item 7)', () => {
  it('GREEN (7-1): parseVerdict reads ONLY the post-marker region — the pre-marker decoy is never parsed', () => {
    const { parseVerdict } = M();
    // Teeth: the fixture carries a DISTINCT pre-marker decoy (VERDICT: BLOCKED),
    // so a non-region-bounded parse would read the wrong verdict/findings.
    assert.ok(liveTranscript.includes('decoy-before-marker'), 'precondition: the fixture has a distinct pre-marker decoy verdict');
    const parsed = parseVerdict(liveTranscript, { platform: 'codex' });
    assert.equal(parsed.verdict, 'APPROVED_WITH_NOTES', 'the region-bounded parse reads the post-marker verdict, not the pre-marker BLOCKED decoy');
    assert.match(parsed.findings, /17 unrelated spawn\/integration failures/, 'the parsed findings carry the verbatim post-marker findings tail');
    assert.doesNotMatch(parsed.findings, /decoy-before-marker/, 'the pre-marker decoy findings are NEVER parsed (region bounding proven)');
  });

  it('GREEN (7-2): classify(transcriptTail(live), exitCode 0, codex) === ok — the live exit-0 tail false-positives no signature', () => {
    const cls = classify({ text: transcriptTail(liveTranscript), exitCode: 0, platform: 'codex', table: shippedTable }).class;
    assert.equal(cls, 'ok', 'a healthy exit-0 live transcript tail must not match any death signature (D1 pinned against reality)');
  });
});
