import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAttribution } from '../../core/src/scaffold/attribution.mjs';

// ---------------------------------------------------------------------------
// Contract choices for core/src/scaffold/attribution.mjs (docs/design/core.md
// §Module APIs "mergeAttribution(existingJsonText|null, {force}) -> {text,
// changed, warnings} | {error}"; §Per-module test lists "attribution merge
// (absent/present/non-empty/malformed-refuse)"; plan §Attribution guard layer 1
// "init deep-merges .claude/settings.json -> {\"attribution\": {\"commit\": \"\",
// \"pr\": \"\"}} (only when keys absent; refuses to touch malformed JSON)").
//
// TARGET MODULE: core/src/scaffold/attribution.mjs (this file's sole target —
// its absence is the only reason this file is RED). The signature above is the
// ONLY scaffold-module signature the design doc pins verbatim, so it is unit-
// tested directly here; the gitignore + managed-block transforms have their own
// files, and the two-phase plan/apply (scaffold/plan.mjs) is exercised through
// the init command + the attribution invariant.
//
// PINS (where the design left room):
//   R1. RETURN SHAPE. Success -> {text: string, changed: boolean, warnings:
//       string[]}. `text` is the full new .claude/settings.json BODY (a JSON
//       string). Refusal on unparseable input -> {error: string} (the `error`
//       key is the discriminator; no `text` is produced). Purity: no fs, no io.
//   R2. THE MANAGED KEYS are exactly attribution.commit and attribution.pr, both
//       set to the empty string "" — the deprecation-safe form (plan decision 7:
//       includeCoAuthoredBy is deprecated). Nothing else under attribution is
//       introduced.
//   R3. ABSENT -> ADD. null input (no settings file yet) yields settings whose
//       parsed value deep-equals {attribution:{commit:"",pr:""}} and changed:true.
//       Existing settings WITHOUT an attribution block gains ONLY the attribution
//       block; every pre-existing top-level key is preserved with its value.
//   R4. PRESENT -> NO CLOBBER ("only when keys absent"). When a key already
//       exists under attribution — REGARDLESS of its value, empty OR non-empty —
//       the default merge leaves that key's value byte-for-byte as-is and reports
//       changed:false for the already-complete case. A pre-existing NON-EMPTY
//       attribution.commit (e.g. a co-author trailer someone set) is NEVER
//       overwritten by the default merge; this is the "non-empty" case from the
//       design's test list. (The attribution INVARIANT catches attribution
//       strings in rendered output; this function must not silently erase a
//       user's own setting.)
//   R5. force:true OVERRIDES. With {force:true} the two managed keys are set to
//       "" even when already present with a non-empty value, and changed reflects
//       whether anything actually changed. force is the explicit-intent override;
//       default (no force / force:false) is R4.
//   R6. MALFORMED -> REFUSE. Unparseable existing JSON yields {error: ...} and
//       produces no text — init must never rewrite a settings file it cannot
//       parse (plan: "refuses to touch malformed JSON").
//   R7. IDEMPOTENT + DETERMINISTIC. Feeding a result's text back in yields
//       changed:false and a byte-identical text; repeated calls on the same input
//       are byte-identical. Assertions compare PARSED values (not bytes) except
//       where idempotency requires byte-equality, so the JSON pretty-print style
//       is left to the implementer.
// ---------------------------------------------------------------------------

const EMPTY_ATTR = { commit: '', pr: '' };

/** Discriminate the {error} refusal branch from a success result. */
const isError = (r) => r && typeof r === 'object' && typeof r.error === 'string' && !('text' in r);

/** Parse a success result's text; fail loudly if it is not valid JSON. */
function parsed(r) {
  assert.ok(!isError(r), `expected a success result, got an error: ${r && r.error}`);
  assert.equal(typeof r.text, 'string', 'a success result carries a string `text`');
  assert.equal(typeof r.changed, 'boolean', 'a success result carries a boolean `changed`');
  assert.ok(Array.isArray(r.warnings), 'a success result carries a `warnings` array');
  return JSON.parse(r.text);
}

// ===========================================================================
describe('scaffold/attribution.mergeAttribution — absent keys are added', () => {
  it('null input (no settings file yet) produces {attribution:{commit:"",pr:""}}, changed:true', () => {
    const r = mergeAttribution(null, {});
    const obj = parsed(r);
    assert.deepEqual(obj.attribution, EMPTY_ATTR, 'the empty-string managed keys are written');
    assert.equal(r.changed, true, 'creating the block from nothing is a change');
  });

  it('existing settings WITHOUT attribution gains only the attribution block; other keys preserved', () => {
    const existing = JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash'] } }, null, 2);
    const r = mergeAttribution(existing, {});
    const obj = parsed(r);
    assert.deepEqual(obj.attribution, EMPTY_ATTR, 'the attribution block is added');
    assert.equal(obj.theme, 'dark', 'a pre-existing scalar key is preserved');
    assert.deepEqual(obj.permissions, { allow: ['Bash'] }, 'a pre-existing nested key is preserved untouched');
    assert.equal(r.changed, true, 'adding the block is a change');
  });

  it('adds a missing key when the other is already present (deep-merge, not replace)', () => {
    const existing = JSON.stringify({ attribution: { commit: '' } }); // pr is absent
    const r = mergeAttribution(existing, {});
    const obj = parsed(r);
    assert.equal(obj.attribution.commit, '', 'the present key is kept');
    assert.equal(obj.attribution.pr, '', 'the absent key is filled in');
    assert.equal(r.changed, true, 'filling a missing key is a change');
  });
});

// ===========================================================================
describe('scaffold/attribution.mergeAttribution — present keys are never clobbered by default', () => {
  it('both managed keys already "" -> no change (changed:false), text round-trips', () => {
    const existing = JSON.stringify({ attribution: { commit: '', pr: '' } }, null, 2);
    const r = mergeAttribution(existing, {});
    const obj = parsed(r);
    assert.deepEqual(obj.attribution, EMPTY_ATTR);
    assert.equal(r.changed, false, 'an already-complete block is a no-op');
  });

  it('(non-empty case) a user-set non-empty attribution.commit is PRESERVED, not overwritten', () => {
    const existing = JSON.stringify({ attribution: { commit: 'Co-authored-by: Someone', pr: '' }, theme: 'light' });
    const r = mergeAttribution(existing, {});
    const obj = parsed(r);
    assert.equal(
      obj.attribution.commit,
      'Co-authored-by: Someone',
      'a present key (even non-empty) is not clobbered by the default merge — "only when keys absent"',
    );
    assert.equal(obj.attribution.pr, '', 'the already-present empty key stays empty');
    assert.equal(obj.theme, 'light', 'unrelated keys are preserved');
    assert.equal(r.changed, false, 'no key was absent, so nothing changed');
  });
});

// ===========================================================================
describe('scaffold/attribution.mergeAttribution — force overrides present values', () => {
  it('force:true resets a non-empty attribution.commit to ""', () => {
    const existing = JSON.stringify({ attribution: { commit: 'Co-authored-by: Someone', pr: 'x' } });
    const r = mergeAttribution(existing, { force: true });
    const obj = parsed(r);
    assert.deepEqual(obj.attribution, EMPTY_ATTR, 'force sets both managed keys back to ""');
    assert.equal(r.changed, true, 'forcing an override of non-empty values is a change');
  });

  it('force:true on an already-empty block is still a no-op (changed:false)', () => {
    const existing = JSON.stringify({ attribution: { commit: '', pr: '' } });
    const r = mergeAttribution(existing, { force: true });
    assert.deepEqual(parsed(r).attribution, EMPTY_ATTR);
    assert.equal(r.changed, false, 'force changes nothing when the values already match');
  });
});

// ===========================================================================
describe('scaffold/attribution.mergeAttribution — refuses malformed JSON', () => {
  it('unparseable existing JSON -> {error}, no text produced', () => {
    const r = mergeAttribution('{ this is not: valid json', {});
    assert.ok(isError(r), 'a malformed settings file must return an {error}, not a rewrite');
    assert.ok(!('text' in r), 'a refusal must not produce a text to write — the file is left untouched by the caller');
  });

  it('force does NOT rescue malformed JSON (still refuses)', () => {
    const r = mergeAttribution(']]not json[[', { force: true });
    assert.ok(isError(r), 'force never overrides the refuse-to-touch-malformed rule');
  });
});

// ===========================================================================
describe('scaffold/attribution.mergeAttribution — idempotency and determinism', () => {
  it('re-merging a merged result is a byte-identical no-op', () => {
    const first = mergeAttribution(JSON.stringify({ theme: 'dark' }), {});
    assert.equal(first.changed, true);
    const second = mergeAttribution(first.text, {});
    assert.equal(second.changed, false, 'the second run detects nothing to add');
    assert.equal(second.text, first.text, 'a second merge is byte-identical (idempotent output)');
  });

  it('is deterministic across repeated calls on the same input', () => {
    const existing = JSON.stringify({ theme: 'dark' });
    assert.equal(mergeAttribution(existing, {}).text, mergeAttribution(existing, {}).text);
  });

  it('does not mutate — repeated calls with the same string argument are independent', () => {
    const existing = JSON.stringify({ attribution: { commit: 'keep-me' } });
    mergeAttribution(existing, {});
    const again = mergeAttribution(existing, {});
    assert.equal(parsed(again).attribution.commit, 'keep-me', 'the input is pure data; nothing is retained between calls');
  });
});
