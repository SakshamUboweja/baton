// Byte-exact golden-file assertions for deterministic renderers.
//
// assertGolden(name, text) compares `text` against the committed fixture
// tests/helpers/fixtures/golden/<name>.txt. On mismatch it fails with a diff
// hint. Running the suite with UPDATE_GOLDEN=1 rewrites the fixture instead of
// asserting (the ~40-line helper the plan calls for). Fixtures are hand-authored
// and committed to pin the exact wire format — the renderer must reproduce them
// byte-for-byte, so an accidental format change is a loud, reviewable failure.
//
// Uses the real node:fs on purpose: the fixtures live on disk in the repo, not
// in a memfs fake.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(HERE, 'fixtures', 'golden');

/** Absolute path of the golden fixture for `name`. */
export function goldenPath(name) {
  return join(GOLDEN_DIR, `${name}.txt`);
}

/**
 * Assert `actual` equals the committed golden fixture `name`, byte-for-byte.
 * UPDATE_GOLDEN=1 rewrites the fixture and returns without asserting.
 * @param {string} name
 * @param {string} actual
 */
export function assertGolden(name, actual) {
  const path = goldenPath(name);
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  if (!existsSync(path)) {
    throw new Error(
      `golden fixture missing: ${path}\n` +
        'run the suite with UPDATE_GOLDEN=1 to create it (only when the value is verified correct).',
    );
  }
  const expected = readFileSync(path, 'utf8');
  assert.equal(
    actual,
    expected,
    `golden mismatch for "${name}". If this change is intentional and correct, ` +
      'regenerate with UPDATE_GOLDEN=1; otherwise the renderer diverged from the pinned format.',
  );
}
