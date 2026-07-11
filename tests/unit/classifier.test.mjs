import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { classify } from '../../core/src/detect/classifier.mjs';
import { loadSignatures } from '../../core/src/detect/signatures.mjs';

// The REAL shipped table (fold C1-2): the negative/near-miss corpus is run
// through core/data/signatures.v1.json via the same loader the built-in pin
// tests use, so an overbroad shipped regex that false-positives "usage limit"
// prose is caught here — not just against an inline BASE table.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const REAL_SIGNATURES_PATH = join(repoRoot, 'core', 'data', 'signatures.v1.json');
const realIo = { fs: nodeFs };

// ===========================================================================
// Contract choices for detect/classifier.mjs. Source of truth:
// docs/design/core.md §Module APIs (classify signature + return shape),
// §"signatures/classifier" test list; plan §Core engine — Limit detector
// (structured-first, exit-code rule iteration 3, ANSI strip, precedence,
// reset-hint extraction, negative corpus). classify is PURE.
//
// SIGNATURE (input): classify({text, exitCode, platform, table, structured}).
//   - `table` is the loadSignatures return value; classify reads table.signatures
//     (a FLAT array), and only applies signatures whose `platform` === platform.
//   - Tables here are built inline (plain data) so this file's red phase is
//     attributable to classifier.mjs alone (not signatures.mjs / the data file).
//
// RETURN: { class, signatureId, confidence, resetHint }  (tried? is added by the
//   detect command under --explain, not by classify itself, so it is NOT pinned
//   here). class ∈ 'ok'|'usage-limit'|'auth'|'throttle'|'other-error'.
//
// PINS:
//   1. STRUCTURED-FIRST. TWO structured kinds are recognized, and for BOTH the
//      TEXT AND EXIT CODE ARE IGNORED (structured evidence wins outright):
//        (a) {kind:'stop-failure', errorType} — Claude Code StopFailure enum
//            (platform-notes.md snapshot). errorType maps (fold C1-4 completes
//            the enum — invalid_request / model_not_found / max_output_tokens
//            were previously omitted):
//               rate_limit                         -> usage-limit
//               overloaded                         -> throttle
//               authentication_failed              -> auth
//               oauth_org_not_allowed              -> auth
//               billing_error                      -> auth
//               invalid_request                    -> other-error
//               model_not_found                    -> other-error
//               server_error                       -> other-error
//               max_output_tokens                  -> other-error
//               unknown / any unrecognized value   -> other-error
//        (b) {kind:'exec-json', errorType} — Codex `codex exec --json` limit
//            evidence (fold C1-4). errorType 'usage_limit' -> usage-limit.
//      signatureId = `structured:<errorType>` for both kinds (rate_limit pinned
//      exactly to 'structured:rate_limit'; codex usage_limit -> 'structured:usage_limit').
//      Structured confidence = 'high'. resetHint = null.
//      A structured value with a kind OTHER than these two (e.g. 'some-other-event')
//      is ignored and classification falls through to the text/exit-code tiers.
//   2. TEXT TIER. ANSI escape sequences are stripped before matching.
//      Precedence when multiple signatures match: usage-limit > auth > throttle
//      > other-error. A matched signature's `confidence` and `id` are carried
//      through (signatureId === sig.id, confidence === sig.confidence).
//   3. RESET-HINT EXTRACTION. When the matched signature carries a `resetHint`
//      regex, classify runs it against the (ANSI-stripped) text and returns
//      match[1] ?? match[0] (first capture group if present, else whole match);
//      no regex or no match -> resetHint null. A matched signature with no
//      resetHint -> resetHint null.
//   4. EXIT-CODE RULE. A matching signature WINS regardless of exit code. With
//      NO matching signature: nonzero exit -> other-error (NEVER usage-limit);
//      zero exit -> ok. No-match verdicts carry signatureId null, resetHint null.
//   5. json-field matcher parses each LINE of text as JSON and compares a dotted
//      path to `equals`.
// ===========================================================================

const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

const mkTable = (signatures) => ({ schema: 'baton/signatures@1', updated: '2026-07-11', signatures });
const sig = (id, platform, cls, matcher, confidence = 'high', resetHint) => {
  const s = { id, platform, class: cls, confidence, matcher };
  if (resetHint !== undefined) s.resetHint = resetHint;
  return s;
};

// A small canonical table reused across text-tier tests.
const ccSession = sig('cc/session', 'claude-code', 'usage-limit', { kind: 'substring', value: "You've hit your session limit" }, 'high', 'resets ([^\\n]+)');
const ccThrottle = sig('cc/throttle', 'claude-code', 'throttle', { kind: 'substring', value: 'Server is temporarily limiting requests' }, 'high');
const ccAuth = sig('cc/auth', 'claude-code', 'auth', { kind: 'substring', value: 'authentication_failed' }, 'high');
const ccOther = sig('cc/429', 'claude-code', 'other-error', { kind: 'substring', value: '429' }, 'high');
const codexUsage = sig('codex/usage', 'codex', 'usage-limit', { kind: 'substring', value: "You've hit your usage limit" }, 'high', 'try again at ([^\\n.]+)');
const cursorThrottle = sig('cursor/too-many', 'cursor', 'throttle', { kind: 'json-field', path: 'error', equals: 'Too Many Requests' }, 'medium');

const BASE = mkTable([ccSession, ccThrottle, ccAuth, ccOther, codexUsage, cursorThrottle]);

// ---------------------------------------------------------------------------
describe('classifier.classify — structured-first (StopFailure errorType map)', () => {
  const cases = [
    ['rate_limit', 'usage-limit', 'structured:rate_limit'],
    ['overloaded', 'throttle', 'structured:overloaded'],
    ['authentication_failed', 'auth', 'structured:authentication_failed'],
    ['oauth_org_not_allowed', 'auth', 'structured:oauth_org_not_allowed'],
    ['billing_error', 'auth', 'structured:billing_error'],
    ['invalid_request', 'other-error', 'structured:invalid_request'],
    ['model_not_found', 'other-error', 'structured:model_not_found'],
    ['server_error', 'other-error', 'structured:server_error'],
    ['max_output_tokens', 'other-error', 'structured:max_output_tokens'],
    ['unknown', 'other-error', 'structured:unknown'],
    ['some_future_value', 'other-error', 'structured:some_future_value'],
  ];
  for (const [errorType, expectedClass, expectedSigId] of cases) {
    it(`${errorType} -> ${expectedClass} (confidence high, signatureId ${expectedSigId})`, () => {
      const r = classify({
        text: 'irrelevant text mentioning nothing',
        exitCode: 0,
        platform: 'claude-code',
        table: BASE,
        structured: { kind: 'stop-failure', errorType },
      });
      assert.equal(r.class, expectedClass);
      assert.equal(r.signatureId, expectedSigId);
      assert.equal(r.confidence, 'high');
      assert.equal(r.resetHint, null);
    });
  }

  it('rate_limit is pinned exactly to signatureId "structured:rate_limit"', () => {
    const r = classify({ text: '', exitCode: 0, platform: 'claude-code', table: BASE, structured: { kind: 'stop-failure', errorType: 'rate_limit' } });
    assert.equal(r.signatureId, 'structured:rate_limit');
  });

  it('structured verdicts IGNORE text — a usage-limit string cannot override a billing_error structured signal', () => {
    const r = classify({
      text: "You've hit your session limit · resets 3:45pm", // would be usage-limit via text
      exitCode: 0,
      platform: 'claude-code',
      table: BASE,
      structured: { kind: 'stop-failure', errorType: 'billing_error' },
    });
    assert.equal(r.class, 'auth', 'structured billing_error wins over the usage-limit text signature');
    assert.equal(r.resetHint, null, 'no reset hint is extracted when text is ignored');
  });

  it('a structured value with an UNRECOGNIZED kind (neither stop-failure nor exec-json) falls through to text', () => {
    const r = classify({
      text: "You've hit your session limit · resets 3:45pm",
      exitCode: 0,
      platform: 'claude-code',
      table: BASE,
      structured: { kind: 'some-other-event', errorType: 'rate_limit' },
    });
    assert.equal(r.class, 'usage-limit', 'unrecognized structured kind falls through to text-tier matching');
    assert.equal(r.signatureId, 'cc/session');
  });
});

// ---------------------------------------------------------------------------
// A codex-SCOPED throttle signature so the contradictory text below is genuinely
// reachable for platform 'codex' — a text-first implementation would classify it
// throttle, so only structured-first passes (verifier iteration-2 finding 1).
const codexThrottle = sig('codex/throttle', 'codex', 'throttle', { kind: 'substring', value: 'Rate limited, retrying request shortly' }, 'medium');
const BASE_WITH_CODEX_THROTTLE = mkTable([ccSession, ccThrottle, ccAuth, ccOther, codexUsage, codexThrottle, cursorThrottle]);

describe('classifier.classify — structured Codex exec-json (limit evidence wins over text + exit) (fold C1-4)', () => {
  it('control: the contradictory text IS codex-reachable — without structured it classifies throttle', () => {
    const r = classify({
      text: 'Rate limited, retrying request shortly',
      exitCode: 0,
      platform: 'codex',
      table: BASE_WITH_CODEX_THROTTLE,
    });
    assert.equal(r.class, 'throttle', 'text tier alone must classify this codex-scoped throttle string');
    assert.equal(r.signatureId, 'codex/throttle');
  });

  it("{kind:'exec-json', errorType:'usage_limit'} -> usage-limit, winning over contradictory text and exit code 0", () => {
    const r = classify({
      // Contradictory evidence on BOTH fallback tiers: the text alone matches the
      // codex-scoped throttle signature (proven by the control above), and exit 0
      // alone would be 'ok'. The structured codex exec-json limit signal must
      // override both.
      text: 'Rate limited, retrying request shortly',
      exitCode: 0,
      platform: 'codex',
      table: BASE_WITH_CODEX_THROTTLE,
      structured: { kind: 'exec-json', errorType: 'usage_limit' },
    });
    assert.equal(r.class, 'usage-limit', 'the structured codex exec-json usage_limit signal wins over text + exit');
    assert.equal(r.signatureId, 'structured:usage_limit');
    assert.equal(r.confidence, 'high');
    assert.equal(r.resetHint, null);
  });

  it("exec-json usage_limit wins even with a NONZERO exit code and unrelated text", () => {
    const r = classify({
      text: 'Error: build failed with 3 errors',
      exitCode: 137,
      platform: 'codex',
      table: BASE,
      structured: { kind: 'exec-json', errorType: 'usage_limit' },
    });
    assert.equal(r.class, 'usage-limit');
    assert.equal(r.signatureId, 'structured:usage_limit');
  });
});

// ---------------------------------------------------------------------------
describe('classifier.classify — text tier: matching, precedence, confidence', () => {
  it('matches a substring signature and carries its id + confidence', () => {
    const r = classify({ text: "You've hit your usage limit. Please try again at 6:00 PM.", exitCode: 1, platform: 'codex', table: BASE });
    assert.equal(r.class, 'usage-limit');
    assert.equal(r.signatureId, 'codex/usage');
    assert.equal(r.confidence, 'high');
  });

  it('carries a non-high confidence from the matched signature (medium via json-field)', () => {
    const r = classify({ text: '{"error":"Too Many Requests","message":"Rate limit exceeded"}', exitCode: 1, platform: 'cursor', table: BASE });
    assert.equal(r.class, 'throttle');
    assert.equal(r.signatureId, 'cursor/too-many');
    assert.equal(r.confidence, 'medium');
  });

  it('strips ANSI escape sequences before matching', () => {
    const text = `${ANSI_RED}You've hit your session limit${ANSI_RESET} · resets 3:45pm`;
    const r = classify({ text, exitCode: 0, platform: 'claude-code', table: BASE });
    assert.equal(r.class, 'usage-limit');
    assert.equal(r.signatureId, 'cc/session');
  });

  it('precedence: usage-limit beats throttle when both match', () => {
    // Contains BOTH the throttle substring and the usage-limit substring.
    const text = "Server is temporarily limiting requests — also You've hit your session limit";
    const r = classify({ text, exitCode: 0, platform: 'claude-code', table: BASE });
    assert.equal(r.class, 'usage-limit');
  });

  it('precedence: auth beats throttle when both match', () => {
    const text = 'authentication_failed and also Server is temporarily limiting requests';
    const r = classify({ text, exitCode: 0, platform: 'claude-code', table: BASE });
    assert.equal(r.class, 'auth');
  });

  it('precedence: throttle beats other-error when both match', () => {
    const text = 'Server is temporarily limiting requests (429)';
    const r = classify({ text, exitCode: 0, platform: 'claude-code', table: BASE });
    assert.equal(r.class, 'throttle');
  });

  it('only applies signatures for the given platform (a claude-code sig does not fire for codex)', () => {
    const r = classify({ text: "You've hit your session limit", exitCode: 0, platform: 'codex', table: BASE });
    // No codex signature matches this claude-code-only string; zero exit -> ok.
    assert.equal(r.class, 'ok');
    assert.equal(r.signatureId, null);
  });
});

// ---------------------------------------------------------------------------
describe('classifier.classify — reset-hint extraction', () => {
  it('extracts "3:45pm" from a claude-code session-limit line (capture group 1)', () => {
    const r = classify({ text: "You've hit your session limit · resets 3:45pm", exitCode: 0, platform: 'claude-code', table: BASE });
    assert.equal(r.class, 'usage-limit');
    assert.equal(r.resetHint, '3:45pm');
  });

  it('extracts "Mon 12:00am" from a differently-phrased reset line', () => {
    const r = classify({ text: "You've hit your session limit · resets Mon 12:00am", exitCode: 0, platform: 'claude-code', table: BASE });
    assert.equal(r.resetHint, 'Mon 12:00am');
  });

  it('extracts "6:00 PM" from a codex "try again at …" line', () => {
    const r = classify({ text: "You've hit your usage limit. Please try again at 6:00 PM.", exitCode: 1, platform: 'codex', table: BASE });
    assert.equal(r.class, 'usage-limit');
    assert.equal(r.resetHint, '6:00 PM');
  });

  it('a matched signature with no resetHint regex yields resetHint null', () => {
    const r = classify({ text: 'Server is temporarily limiting requests', exitCode: 0, platform: 'claude-code', table: BASE });
    assert.equal(r.class, 'throttle');
    assert.equal(r.resetHint, null);
  });
});

// ---------------------------------------------------------------------------
describe('classifier.classify — exit-code rule (plan iteration 3)', () => {
  it('nonzero exit + NO matching signature -> other-error (never usage-limit)', () => {
    const r = classify({ text: 'Error: build failed with 3 errors', exitCode: 1, platform: 'codex', table: BASE });
    assert.equal(r.class, 'other-error');
    assert.notEqual(r.class, 'usage-limit');
    assert.equal(r.signatureId, null);
    assert.equal(r.resetHint, null);
  });

  it('zero exit + NO matching signature -> ok', () => {
    const r = classify({ text: 'all good, nothing to report', exitCode: 0, platform: 'codex', table: BASE });
    assert.equal(r.class, 'ok');
    assert.equal(r.signatureId, null);
    assert.equal(r.resetHint, null);
  });

  it('a matching usage-limit signature wins even with a ZERO exit code', () => {
    const r = classify({ text: "You've hit your usage limit. Please try again at 6:00 PM.", exitCode: 0, platform: 'codex', table: BASE });
    assert.equal(r.class, 'usage-limit');
    assert.equal(r.signatureId, 'codex/usage');
  });

  it('a matching usage-limit signature wins even with a NONZERO exit code (exit does not downgrade it)', () => {
    const r = classify({ text: "You've hit your usage limit. Please try again at 6:00 PM.", exitCode: 137, platform: 'codex', table: BASE });
    assert.equal(r.class, 'usage-limit');
  });

  it('a matching throttle signature wins over the exit-code other-error default', () => {
    const r = classify({ text: 'Server is temporarily limiting requests', exitCode: 1, platform: 'claude-code', table: BASE });
    assert.equal(r.class, 'throttle');
  });
});

// ---------------------------------------------------------------------------
describe('classifier.classify — negative / near-miss corpus (must NOT be usage-limit)', () => {
  it('prose "discussing usage limits in code review" (codex, exit 0) is ok, not usage-limit', () => {
    const r = classify({ text: 'We were discussing usage limits in code review yesterday.', exitCode: 0, platform: 'codex', table: BASE });
    assert.notEqual(r.class, 'usage-limit');
    assert.equal(r.class, 'ok');
  });

  it('"session limit design doc" prose (claude-code, exit 0) is ok, not usage-limit', () => {
    const r = classify({ text: 'Here is the session limit design doc for review.', exitCode: 0, platform: 'claude-code', table: BASE });
    assert.notEqual(r.class, 'usage-limit');
    assert.equal(r.class, 'ok');
  });

  it('codex nonzero exit from a syntax error is other-error, not usage-limit', () => {
    const r = classify({ text: 'SyntaxError: Unexpected token } at line 42', exitCode: 1, platform: 'codex', table: BASE });
    assert.equal(r.class, 'other-error');
    assert.notEqual(r.class, 'usage-limit');
  });

  it('cursor JSON error:"Not Found" (exit 0) is ok, not usage-limit and not throttle', () => {
    const r = classify({ text: '{"error":"Not Found","message":"no such route"}', exitCode: 0, platform: 'cursor', table: BASE });
    assert.notEqual(r.class, 'usage-limit');
    assert.notEqual(r.class, 'throttle');
    assert.equal(r.class, 'ok');
  });

  it('the throttle string (with its "not your usage limit" parenthetical) is throttle, NOT usage-limit', () => {
    const r = classify({ text: 'Server is temporarily limiting requests (not your usage limit)', exitCode: 0, platform: 'claude-code', table: BASE });
    assert.equal(r.class, 'throttle');
    assert.notEqual(r.class, 'usage-limit');
  });

  it('empty text: exit 0 -> ok, exit 1 -> other-error; never usage-limit', () => {
    const okr = classify({ text: '', exitCode: 0, platform: 'claude-code', table: BASE });
    assert.equal(okr.class, 'ok');
    assert.notEqual(okr.class, 'usage-limit');

    const errr = classify({ text: '', exitCode: 1, platform: 'claude-code', table: BASE });
    assert.equal(errr.class, 'other-error');
    assert.notEqual(errr.class, 'usage-limit');
  });
});

// ---------------------------------------------------------------------------
// fold C1-2: the SAME negative/near-miss corpus, but classified against the REAL
// shipped table (core/data/signatures.v1.json) loaded through loadSignatures —
// the identical loader the signatures.test.mjs built-in pins use. An overbroad
// shipped regex that false-positives "usage limit" prose fails HERE even though
// the inline-BASE tests above stay green, defeating the weak positive-only split.
describe('classifier.classify — negative / near-miss corpus against the SHIPPED table (real-file pin)', () => {
  const shipped = loadSignatures({ builtinPath: REAL_SIGNATURES_PATH }, realIo);

  const NEGATIVE = [
    { text: 'We were discussing usage limits in code review yesterday.', exitCode: 0, platform: 'codex' },
    { text: 'Here is the session limit design doc for review.', exitCode: 0, platform: 'claude-code' },
    { text: 'SyntaxError: Unexpected token } at line 42', exitCode: 1, platform: 'codex' },
    { text: '{"error":"Not Found","message":"no such route"}', exitCode: 0, platform: 'cursor' },
    { text: 'Server is temporarily limiting requests (not your usage limit)', exitCode: 0, platform: 'claude-code' },
    { text: 'API Error: Request rejected (429)', exitCode: 1, platform: 'claude-code' },
    { text: '', exitCode: 0, platform: 'claude-code' },
    { text: '', exitCode: 1, platform: 'claude-code' },
  ];

  for (const fx of NEGATIVE) {
    const label = `[${fx.platform} exit ${fx.exitCode}] ${JSON.stringify(fx.text).slice(0, 52)}`;
    it(`${label} is NOT usage-limit against the shipped table`, () => {
      const r = classify({ text: fx.text, exitCode: fx.exitCode, platform: fx.platform, table: shipped });
      assert.notEqual(r.class, 'usage-limit', 'a negative fixture must never classify usage-limit against shipped data');
    });
  }

  it('the throttle near-miss classifies throttle (not usage-limit) against the shipped table', () => {
    const r = classify({ text: 'Server is temporarily limiting requests (not your usage limit)', exitCode: 0, platform: 'claude-code', table: shipped });
    assert.equal(r.class, 'throttle');
    assert.notEqual(r.class, 'usage-limit');
  });

  it('the 429 rejection classifies other-error (not usage-limit) against the shipped table', () => {
    const r = classify({ text: 'API Error: Request rejected (429)', exitCode: 1, platform: 'claude-code', table: shipped });
    assert.equal(r.class, 'other-error');
    assert.notEqual(r.class, 'usage-limit');
  });
});

// ---------------------------------------------------------------------------
describe('classifier.classify — json-field matcher', () => {
  it('matches a JSON line embedded in multi-line output', () => {
    const text = 'starting request\n{"error":"Too Many Requests"}\nrequest failed';
    const r = classify({ text, exitCode: 1, platform: 'cursor', table: BASE });
    assert.equal(r.class, 'throttle');
    assert.equal(r.signatureId, 'cursor/too-many');
  });

  it('does not match when the dotted-path value differs', () => {
    const r = classify({ text: '{"error":"Internal Server Error"}', exitCode: 0, platform: 'cursor', table: BASE });
    assert.notEqual(r.class, 'throttle');
    assert.equal(r.class, 'ok');
  });

  it('compares a DOTTED path against nested JSON', () => {
    const table = mkTable([
      sig('cursor/nested', 'cursor', 'usage-limit', { kind: 'json-field', path: 'error.code', equals: 'usage_limit' }, 'low'),
    ]);
    const r = classify({ text: '{"error":{"code":"usage_limit","http":429}}', exitCode: 1, platform: 'cursor', table });
    assert.equal(r.class, 'usage-limit');
    assert.equal(r.signatureId, 'cursor/nested');
  });

  it('ignores non-JSON lines without throwing', () => {
    const text = 'not json at all { broken\nstill not json';
    const r = classify({ text, exitCode: 0, platform: 'cursor', table: BASE });
    assert.equal(r.class, 'ok');
  });
});
