import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyManagedBlock } from '../../core/src/scaffold/managed-block.mjs';

// ---------------------------------------------------------------------------
// Contract choices for core/src/scaffold/managed-block.mjs (docs/design/core.md
// §file tree "managed-block.mjs — <!-- baton:begin/end --> merges"; §Per-module
// test lists "managed-block replace/append/corrupt-marker-refuse with
// outside-bytes invariance"; plan §Scaffold "AGENTS.md/CLAUDE.md written via
// managed blocks (<!-- baton:begin/end -->) — bytes outside markers never
// touched").
//
// TARGET MODULE: core/src/scaffold/managed-block.mjs (sole target — its absence
// is the only reason this file is RED).
//
// SIGNATURE (pinned — the design names the module but not the function):
//   applyManagedBlock(existingText: string | null, body: string)
//     -> {text: string, changed: boolean} | {error: string}
//   PURE (text in, text out; no fs, no io). The MARKERS are exactly the literal
//   lines "<!-- baton:begin -->" and "<!-- baton:end -->" (matching the plan's
//   §Scaffold and §Attribution-guard wording). `body` is the managed content to
//   place between them (the caller supplies the rendered template body).
//
// PINS (where the design left room):
//   M1. OUTSIDE-BYTES INVARIANCE is the load-bearing property, asserted by
//       SLICING at the marker strings: for any successful result, the text up to
//       and including the begin marker's line and the text from the end marker's
//       line onward are byte-for-byte identical to the corresponding regions of
//       the input (append: the entire prior body is an exact prefix). The tests
//       assert region equality, NOT the exact newlines the implementer puts
//       around `body`, so the inner formatting is left open while the invariant
//       is nailed shut.
//   M2. REPLACE. When BOTH markers are present (begin before end), the content
//       BETWEEN them is replaced with `body`. Everything before the begin marker
//       and everything after the end marker is preserved exactly. Replacing an
//       identical body is a no-op (changed:false, byte-identical text).
//   M3. APPEND. When NEITHER marker is present, a managed block (begin marker,
//       body, end marker) is appended and changed:true. The prior body is an
//       exact prefix of the result; both markers now appear, with `body` between
//       them. null / "" input -> a fresh managed block, changed:true.
//   M4. CORRUPT-MARKER REFUSE. A begin marker without a matching end, an end
//       before a begin, or more than one begin/end pair -> {error} and NO text
//       (the `error` key is the discriminator). The caller leaves the file
//       untouched; a half-marked file is never guessed at.
//   M5. IDEMPOTENT + DETERMINISTIC. Re-applying the SAME body to a prior result
//       is changed:false and byte-identical; repeated calls are byte-identical.
// ---------------------------------------------------------------------------

const BEGIN = '<!-- baton:begin -->';
const END = '<!-- baton:end -->';

const isError = (r) => r && typeof r === 'object' && typeof r.error === 'string' && !('text' in r);

function ok(r) {
  assert.ok(!isError(r), `expected a success result, got an error: ${r && r.error}`);
  assert.equal(typeof r.text, 'string', 'success carries string text');
  assert.equal(typeof r.changed, 'boolean', 'success carries boolean changed');
  return r;
}

/** The bytes strictly before the begin marker. */
const beforeBegin = (s) => s.slice(0, s.indexOf(BEGIN));
/** The bytes strictly after the end marker. */
const afterEnd = (s) => s.slice(s.indexOf(END) + END.length);

// ===========================================================================
describe('scaffold/managed-block.applyManagedBlock — append when no markers exist', () => {
  it('null input -> a fresh managed block containing the body between the markers, changed:true', () => {
    const r = ok(applyManagedBlock(null, 'BATON BODY'));
    assert.equal(r.changed, true);
    assert.ok(r.text.includes(BEGIN) && r.text.includes(END), 'both markers are present');
    assert.ok(r.text.indexOf(BEGIN) < r.text.indexOf('BATON BODY'), 'body follows the begin marker');
    assert.ok(r.text.indexOf('BATON BODY') < r.text.indexOf(END), 'body precedes the end marker');
  });

  it('appends to pre-existing USER content, preserving every prior byte (outside-bytes invariance)', () => {
    const user = '# My Project\n\nSome hand-written guidance the user owns.\n';
    const r = ok(applyManagedBlock(user, 'MANAGED CONTENT'));
    assert.equal(r.changed, true);
    assert.ok(r.text.startsWith(user), 'the entire prior body is preserved as an exact prefix — nothing above the block is touched');
    // The region before the begin marker is exactly the user's content.
    assert.equal(beforeBegin(r.text), user, 'the bytes before the managed block equal the original file byte-for-byte');
    assert.ok(r.text.includes('MANAGED CONTENT'), 'the new body is inside the appended block');
  });
});

// ===========================================================================
describe('scaffold/managed-block.applyManagedBlock — replace between existing markers', () => {
  const TOP = '# AGENTS\n\nUser preamble above the block.\n';
  const BOTTOM = '\n## A user section BELOW the managed block\n\nMore user bytes.\n';
  const existing = `${TOP}${BEGIN}\nOLD MANAGED BODY\n${END}${BOTTOM}`;

  it('replaces only the content between the markers; bytes OUTSIDE are byte-for-byte identical', () => {
    const r = ok(applyManagedBlock(existing, 'NEW MANAGED BODY'));
    assert.equal(r.changed, true);

    // Outside-bytes invariance: prefix (through begin) and suffix (from end) match.
    assert.equal(beforeBegin(r.text), beforeBegin(existing), 'everything before the begin marker is unchanged');
    assert.equal(afterEnd(r.text), afterEnd(existing), 'everything after the end marker is unchanged');

    // The managed region changed.
    assert.ok(r.text.includes('NEW MANAGED BODY'), 'the new body is written between the markers');
    assert.ok(!r.text.includes('OLD MANAGED BODY'), 'the old managed body is gone');

    // Sanity: the user's above/below content survived verbatim.
    assert.ok(r.text.startsWith(TOP), 'the user preamble is intact');
    assert.ok(r.text.endsWith(BOTTOM), 'the user section below the block is intact');
  });

  it('replacing with the identical body is a byte-identical no-op (changed:false)', () => {
    const r = ok(applyManagedBlock(existing, 'OLD MANAGED BODY'));
    assert.equal(r.changed, false, 're-writing the same body changes nothing');
    assert.equal(r.text, existing, 'the file is returned byte-for-byte');
  });
});

// ===========================================================================
describe('scaffold/managed-block.applyManagedBlock — refuses corrupt markers', () => {
  it('a begin marker with NO matching end -> {error}, no text', () => {
    const r = applyManagedBlock(`prefix\n${BEGIN}\ndangling managed body with no end\n`, 'X');
    assert.ok(isError(r), 'an unterminated managed block must be refused, not guessed');
    assert.ok(!('text' in r), 'a refusal produces no rewrite');
  });

  it('an end marker appearing BEFORE the begin marker -> {error}', () => {
    const r = applyManagedBlock(`${END}\nweird\n${BEGIN}\n`, 'X');
    assert.ok(isError(r), 'markers out of order are corrupt');
  });

  it('a DUPLICATED begin marker (two managed blocks) -> {error}', () => {
    const r = applyManagedBlock(`${BEGIN}\na\n${END}\n${BEGIN}\nb\n${END}\n`, 'X');
    assert.ok(isError(r), 'more than one managed block is ambiguous — refuse');
  });
});

// ===========================================================================
describe('scaffold/managed-block.applyManagedBlock — idempotency and determinism', () => {
  it('a double apply of the same body is byte-identical (idempotent)', () => {
    const first = ok(applyManagedBlock('# Doc\n', 'BODY v1'));
    const second = ok(applyManagedBlock(first.text, 'BODY v1'));
    assert.equal(second.changed, false, 'the block already holds this body');
    assert.equal(second.text, first.text, 'the second run is byte-identical');
  });

  it('is deterministic across repeated calls', () => {
    assert.equal(ok(applyManagedBlock('# Doc\n', 'B')).text, ok(applyManagedBlock('# Doc\n', 'B')).text);
  });
});
