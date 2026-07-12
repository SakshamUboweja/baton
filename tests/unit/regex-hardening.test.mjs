import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { makeIo } from '../helpers/fakeio.mjs';
import { loadSignatures } from '../../core/src/detect/signatures.mjs';
import { probeRegexSafe } from '../../core/src/detect/probe.mjs';

// ---------------------------------------------------------------------------
// Gate-2 fix 6 (reviewer-a finding 7): the old lint accepted `(a|aa)+$` and a
// `(a|a)*x` overlay hung classify() for 93.8 s (reviewer-b live repro). Two
// layers now: a structural scanner rejecting quantified groups with ambiguous
// bodies (any nesting depth), and a load-time worker probe with a hard
// deadline for pathological shapes that carry no groups at all.
// ---------------------------------------------------------------------------

const BUILTIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'data', 'signatures.v1.json');

const table = (pattern) =>
  JSON.stringify({
    schema: 'baton/signatures@1',
    signatures: [{ id: 'overlay-x', platform: 'codex', class: 'usage-limit', confidence: 'medium', matcher: { kind: 'regex', pattern } }],
  });

/** loadSignatures against the real builtin plus one overlay regex. */
function loadWithOverlay(pattern) {
  // The builtin table ships with the package — read it through the real fs
  // into the fake so the overlay merge path is exercised end to end.
  const io = makeIo({ files: { '/overlay.json': table(pattern), '/builtin.json': readFileSync(BUILTIN, 'utf8') } });
  return loadSignatures({ builtinPath: '/builtin.json', overlayPath: '/overlay.json' }, io);
}

describe('regex lint — structural scanner', () => {
  const rejected = [
    ['(a|a)*x', 'the live-repro alternation'],
    ['(a|aa)+$', 'ambiguous alternation reviewer A fed the old lint'],
    ['(a+b)*', 'inner quantifier not adjacent to the group close'],
    ['((a|a))*', 'nesting one group deep'],
    ['(x(a|b)y)+', 'alternation nested inside a quantified outer group'],
    ['(a*)+', 'the classic nested star'],
    ['(a|b){2,}', 'open-ended brace quantifier over alternation'],
  ];
  for (const [pattern, why] of rejected) {
    it(`rejects ${pattern} (${why})`, () => {
      assert.throws(() => loadWithOverlay(pattern), /overlay-x/);
    });
  }

  const accepted = [
    ["You've hit your \\S+ limit", 'builtin claude-code matcher'],
    ['usage limit exceeded|quota exceeded', 'top-level alternation, no quantified group'],
    ['resets ([^\\n]+)', 'builtin resetHint shape — group is unquantified'],
    ['(abc)+', 'quantified group with a fixed literal body'],
    ['(a|b)?', 'optional group — bounded, never repeats'],
  ];
  for (const [pattern, why] of accepted) {
    it(`accepts ${pattern} (${why})`, () => {
      const merged = loadWithOverlay(pattern);
      assert.ok(merged.signatures.some((s) => s.id === 'overlay-x'));
    });
  }

  it('the shipped builtin table passes the strengthened lint', () => {
    const io = makeIo({ files: { '/builtin.json': readFileSync(BUILTIN, 'utf8') } });
    const t = loadSignatures({ builtinPath: '/builtin.json' }, io);
    assert.ok(Array.isArray(t.signatures) && t.signatures.length > 0);
  });
});

describe('worker probe — hard deadline for group-free pathological shapes', () => {
  // 25 chained stars followed by an unmatchable tail: no groups, so no
  // structural scanner can see it, but backtracking is combinatorial — the
  // verified repro hangs >3 s on a 64-char input.
  const STAR_CHAIN = 'a*'.repeat(25) + 'x';

  it('probeRegexSafe kills the star chain at the deadline', () => {
    const started = Date.now();
    const r = probeRegexSafe(STAR_CHAIN, '');
    assert.equal(r.safe, false);
    assert.match(r.reason, /pathological|deadline|exceeded/i);
    assert.ok(Date.now() - started < 10_000, 'probe must return in bounded time, not hang');
  });

  it('probeRegexSafe passes ordinary limit-string patterns', () => {
    assert.equal(probeRegexSafe("You've hit your \\S+ limit", '').safe, true);
    assert.equal(probeRegexSafe('usage limit exceeded|quota exceeded', 'i').safe, true);
  });

  it('loadSignatures rejects a star-chain overlay in bounded time (the 93.8 s repro)', () => {
    const started = Date.now();
    assert.throws(() => loadWithOverlay(STAR_CHAIN), /overlay-x/);
    assert.ok(Date.now() - started < 10_000, 'rejection must be bounded, not a hang');
  });
});
