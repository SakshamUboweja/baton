import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureIgnoreLine } from '../../core/src/scaffold/gitignore.mjs';

// ---------------------------------------------------------------------------
// Contract choices for core/src/scaffold/gitignore.mjs (docs/design/core.md
// §file tree "gitignore.mjs — ensure-line (pure text transform)"; §Per-module
// test lists "gitignore variants (covering pattern no-op, CRLF, trailing
// newline, idempotent double-run)"; plan §Scaffold ".gitignore ensure-line
// (no-op if an existing pattern covers .handoff/)").
//
// TARGET MODULE: core/src/scaffold/gitignore.mjs (sole target — its absence is
// the only reason this file is RED).
//
// SIGNATURE (pinned — the design names the module but not the function):
//   ensureIgnoreLine(existingText: string | null, pattern: string)
//     -> {text: string, changed: boolean}
//   PURE (text in, text out; no fs, no io). `existingText` is the current
//   .gitignore body, or null when the file does not exist yet. `pattern` is the
//   ignore entry to guarantee (the scaffolder passes ".handoff/").
//
// PINS (where the design left room):
//   G1. COVERING NO-OP. If a NON-COMMENT line, trimmed, already covers the
//       pattern, the function is a no-op: text === existingText byte-for-byte and
//       changed:false. "Covers .handoff/" is satisfied by an existing line equal
//       to the pattern itself (".handoff/") OR to the directory without the
//       trailing slash (".handoff") — git treats both as ignoring the directory,
//       so re-adding is redundant. (A commented-out "# .handoff/" does NOT count
//       as covering.)
//   G2. APPEND WHEN ABSENT. Otherwise the pattern is appended on its own line and
//       changed:true. The result ALWAYS ends with a single trailing newline, and
//       a non-empty prior body is separated from the new line by exactly one
//       newline (no blank-line gap, no lost final line). Every byte of the prior
//       body is preserved (the appended text starts with the original content).
//   G3. NULL / EMPTY. existingText null or "" -> text is exactly the pattern plus
//       a trailing newline, changed:true.
//   G4. CRLF. A body using CRLF line endings is parsed on CRLF for the covering
//       check (a "\r\n"-terminated ".handoff/" line still counts as covering, G1),
//       and no line is duplicated. (The appended-line ending style is left to the
//       implementer; these tests assert the covering no-op and non-duplication,
//       not the CRLF byte of the appended line.)
//   G5. IDEMPOTENT. ensureIgnoreLine(ensureIgnoreLine(x, p).text, p).changed is
//       false and its text is byte-identical to the first result — a double run
//       adds nothing.
// ---------------------------------------------------------------------------

const P = '.handoff/';

// ===========================================================================
describe('scaffold/gitignore.ensureIgnoreLine — appends when the pattern is absent', () => {
  it('null input -> exactly the pattern + trailing newline, changed:true', () => {
    const r = ensureIgnoreLine(null, P);
    assert.equal(r.text, `${P}\n`);
    assert.equal(r.changed, true);
  });

  it('empty input -> exactly the pattern + trailing newline, changed:true', () => {
    const r = ensureIgnoreLine('', P);
    assert.equal(r.text, `${P}\n`);
    assert.equal(r.changed, true);
  });

  it('appends to an unrelated body, preserving every prior byte and ending in one newline', () => {
    const existing = 'node_modules/\ncoverage/\n*.log\n';
    const r = ensureIgnoreLine(existing, P);
    assert.equal(r.changed, true);
    assert.ok(r.text.startsWith(existing), 'the prior body is preserved byte-for-byte as a prefix');
    assert.match(r.text, /(^|\n)\.handoff\/\n$/, 'the pattern lands on its own final line with a single trailing newline');
    assert.ok(!r.text.endsWith('\n\n'), 'no blank-line gap is introduced');
  });

  it('appends correctly when the prior body lacks a trailing newline (no line joined)', () => {
    const existing = 'node_modules/\n*.log'; // no final newline
    const r = ensureIgnoreLine(existing, P);
    assert.equal(r.changed, true);
    const lines = r.text.replace(/\n$/, '').split('\n');
    assert.ok(lines.includes('*.log'), 'the un-terminated final line is not merged into the new one');
    assert.ok(lines.includes('.handoff/'), 'the pattern is present on its own line');
  });
});

// ===========================================================================
describe('scaffold/gitignore.ensureIgnoreLine — covering no-op', () => {
  it('an exact ".handoff/" line already present -> byte-identical no-op', () => {
    const existing = 'node_modules/\n.handoff/\n*.log\n';
    const r = ensureIgnoreLine(existing, P);
    assert.equal(r.changed, false, 'an existing covering line means no change');
    assert.equal(r.text, existing, 'the body is returned byte-for-byte unchanged');
  });

  it('a ".handoff" line without the trailing slash still covers the directory (no-op)', () => {
    const existing = '.handoff\nnode_modules/\n';
    const r = ensureIgnoreLine(existing, P);
    assert.equal(r.changed, false, '".handoff" ignores the directory, so ".handoff/" is redundant');
    assert.equal(r.text, existing);
  });

  it('a COMMENTED-out "# .handoff/" does NOT count as covering (the pattern is still appended)', () => {
    const existing = '# .handoff/\nnode_modules/\n';
    const r = ensureIgnoreLine(existing, P);
    assert.equal(r.changed, true, 'a comment is not an active ignore rule');
    assert.ok(r.text.startsWith(existing), 'the comment body is preserved');
    assert.match(r.text, /(^|\n)\.handoff\/\n$/);
  });
});

// ===========================================================================
describe('scaffold/gitignore.ensureIgnoreLine — CRLF handling', () => {
  it('a CRLF body already containing ".handoff/" is a no-op (line not duplicated)', () => {
    const existing = 'node_modules/\r\n.handoff/\r\n*.log\r\n';
    const r = ensureIgnoreLine(existing, P);
    assert.equal(r.changed, false, 'the covering check must tolerate CRLF endings');
    assert.equal(r.text, existing, 'a CRLF body that already covers is returned unchanged');
  });

  it('a CRLF body WITHOUT the pattern appends it exactly once', () => {
    const existing = 'node_modules/\r\n*.log\r\n';
    const r = ensureIgnoreLine(existing, P);
    assert.equal(r.changed, true);
    const occurrences = r.text.split(/\r?\n/).filter((l) => l.trim() === '.handoff/').length;
    assert.equal(occurrences, 1, 'the pattern appears exactly once, never duplicated');
    assert.ok(r.text.startsWith(existing), 'the prior CRLF body is preserved byte-for-byte');
  });
});

// ===========================================================================
describe('scaffold/gitignore.ensureIgnoreLine — idempotency and purity', () => {
  it('a double run adds nothing and is byte-identical', () => {
    const first = ensureIgnoreLine('node_modules/\n', P);
    assert.equal(first.changed, true);
    const second = ensureIgnoreLine(first.text, P);
    assert.equal(second.changed, false, 'the second run finds the pattern already covering');
    assert.equal(second.text, first.text, 'the second run is byte-identical (idempotent)');
  });

  it('is deterministic across repeated calls', () => {
    const existing = 'node_modules/\n';
    assert.equal(ensureIgnoreLine(existing, P).text, ensureIgnoreLine(existing, P).text);
  });
});
