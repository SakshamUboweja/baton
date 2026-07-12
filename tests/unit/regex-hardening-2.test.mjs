import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { makeIo } from '../helpers/fakeio.mjs';
import { loadSignatures } from '../../core/src/detect/signatures.mjs';
import { probeRegexSafe } from '../../core/src/detect/probe.mjs';

// ---------------------------------------------------------------------------
// Gate-2 iteration-2 findings B3 (reviewer-a #5) + M8 (reviewer-b #1):
// - B3: lint must validate the pattern WITH its flags (an unsupported/duplicate
//   flag that compiles nowhere must be rejected at load, not throw later in
//   classify), and the worker probe must distinguish a compile error from a
//   timeout.
// - M8: the probe's adversarial inputs were built only from literal
//   [A-Za-z0-9] in the pattern, so a group-free chained-star over \d/\s/[!-/]
//   passed the scanner AND the probe, then hung classify. Probe inputs must be
//   generated per character-class so such a pattern is caught.
// ---------------------------------------------------------------------------

const BUILTIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'data', 'signatures.v1.json');

function overlay(sig) {
  return JSON.stringify({ schema: 'baton/signatures@1', signatures: [{ id: 'ov', platform: 'codex', class: 'usage-limit', confidence: 'medium', ...sig }] });
}
function loadWith(sig) {
  const io = makeIo({ files: { '/overlay.json': overlay(sig), '/builtin.json': readFileSync(BUILTIN, 'utf8') } });
  return loadSignatures({ builtinPath: '/builtin.json', overlayPath: '/overlay.json' }, io);
}

describe('lint validates the pattern+flags pair (B3)', () => {
  it('rejects an unsupported regex flag at load', () => {
    assert.throws(() => loadWith({ matcher: { kind: 'regex', pattern: 'usage limit', flags: 'z' } }), /ov/);
  });

  it('rejects duplicate flags at load', () => {
    assert.throws(() => loadWith({ matcher: { kind: 'regex', pattern: 'usage limit', flags: 'ii' } }), /ov/);
  });

  it('accepts a valid flag combination', () => {
    const t = loadWith({ matcher: { kind: 'regex', pattern: 'usage limit', flags: 'im' } });
    assert.ok(t.signatures.some((s) => s.id === 'ov'));
  });

  it('probeRegexSafe reports a compile error distinctly from a timeout', () => {
    const bad = probeRegexSafe('usage', 'z');
    assert.equal(bad.safe, false);
    assert.match(bad.reason, /flag|compile|invalid/i);
    assert.doesNotMatch(bad.reason, /deadline|timed|pathological/i, 'a bad flag is a compile error, not a hang');
  });
});

describe('probe catches group-free pathological patterns over non-alnum classes (M8)', () => {
  const HANGS = [
    ['\\d chained star', '\\d*\\d*\\d*\\d*\\d*\\d*\\d*\\d*\\d*\\d*\\d*\\d*!'],
    ['\\s chained star', '\\s*\\s*\\s*\\s*\\s*\\s*\\s*\\s*\\s*\\s*\\s*\\s*!'],
    ['punctuation class chained star', '[!-/]*[!-/]*[!-/]*[!-/]*[!-/]*[!-/]*[!-/]*[!-/]*[!-/]*[!-/]*X'],
  ];
  for (const [label, pattern] of HANGS) {
    it(`probeRegexSafe rejects: ${label}`, () => {
      const started = Date.now();
      const r = probeRegexSafe(pattern, '');
      assert.equal(r.safe, false, `${label} must be caught by the probe`);
      assert.ok(Date.now() - started < 10_000, 'the probe itself must return in bounded time');
    });
    it(`loadSignatures rejects the overlay: ${label}`, () => {
      const started = Date.now();
      assert.throws(() => loadWith({ matcher: { kind: 'regex', pattern } }), /ov/);
      assert.ok(Date.now() - started < 10_000, 'rejection is bounded, not a hang');
    });
  }

  it('still accepts ordinary linear patterns (no false positive)', () => {
    assert.equal(probeRegexSafe('\\d+ requests remaining', '').safe, true);
    assert.equal(probeRegexSafe('quota exceeded|usage limit', 'i').safe, true);
  });
});
