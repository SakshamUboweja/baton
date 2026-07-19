import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../../core/src/detect/classifier.mjs';

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
//   capLog(text, maxBytes)                   -> string
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
describe('capLog — head + marker + verbatim tail, bounded size', () => {
  it('text under the cap is returned unchanged', () => {
    const { capLog } = M();
    assert.equal(capLog('a short log', 1000), 'a short log');
  });

  it('over-cap text preserves the head, marks the middle, and keeps the TAIL verbatim', () => {
    const { capLog } = M();
    const head = 'HEAD-'.repeat(60); // 300 bytes
    const middle = 'M'.repeat(5000);
    const tail = 'VERDICT: BLOCKED\nFINDINGS: the tail must survive'; // the verdict lives at the end
    const big = head + middle + tail;
    const maxBytes = 1000;
    const capped = capLog(big, maxBytes);

    assert.ok(Buffer.byteLength(capped) <= maxBytes + 256, `capped size within budget + marker slack; got ${Buffer.byteLength(capped)}`);
    assert.ok(capped.startsWith('HEAD-'), 'the head is preserved');
    assert.match(capped, /truncat/i, 'a truncation marker replaces the middle');
    assert.ok(capped.endsWith(tail.slice(-32)), 'the last bytes (the verdict) survive verbatim');
  });

  it('a ROOMY cap keeps the ENTIRE tail verbatim (the full verdict block survives)', () => {
    const { capLog } = M();
    const head = 'HEAD-'.repeat(60); // 300 bytes
    const middle = 'M'.repeat(20000);
    const tail = 'VERDICT: BLOCKED\nFINDINGS:\n1. [high] the whole tail block must survive verbatim';
    const capped = capLog(head + middle + tail, 4000);
    assert.ok(capped.endsWith(tail), 'with headroom the complete tail (not just its last bytes) is preserved verbatim');
    assert.match(capped, /truncat/i, 'the middle is still marked as truncated');
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
