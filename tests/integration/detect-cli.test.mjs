import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// ===========================================================================
// Spawn-level (integration) contract for the not-yet-implemented `baton detect`
// and `baton remap` CLI commands. Pattern mirrors tests/integration/
// cli-spawn.test.mjs (spawnSync of core/bin/baton.mjs; byte-exact --json purity).
//
// Source of truth:
//   - docs/plans/2026-07-11-baton-v1.md §CLI surface + §Limit detector:
//     FROZEN exit-code contract  0 ok · 1 failure · 2 usage · 10 usage-limit ·
//     11 throttle · 12 auth · 13 other-error. "A generic nonzero exit never
//     classifies as usage-limit on its own" (iteration 3).
//   - docs/design/core.md §137 (exit codes + envelope), §90-93 (detect data =
//     {class, signatureId, confidence, resetHint, tried?}), §96-98 (remap data =
//     {assignments: {[role]: {platform, model, mode, chainIndex, skipped[]}},
//     notes[]}).
//   - docs/design/platform-notes.md §16: live capture 2026-07-12 — a reset hint
//     may carry a timezone suffix in parentheses ("resets 2am (Asia/Dubai)");
//     the extractor must cover this variant.
//
// PINS this file asserts at spawn altitude (the pure classifier/resolver
// behaviour is pinned by tests/unit/{classifier,resolve,matrix,signatures}):
//   1. detect maps the classified CLASS to a process EXIT CODE: usage-limit ->
//      10, throttle -> 11, auth -> 12, other-error -> 13, ok -> 0.
//   2. Under --json, stdout is EXACTLY one compact {ok,data,warnings,error}
//      envelope + '\n' (re-serialise-and-compare enforces compactness + no
//      stray stdout), and data carries the classifier's {class, resetHint, ...}.
//   3. A generic nonzero exit with unmatched text is other-error (13), NEVER
//      usage-limit; a zero exit with unmatched text is ok (0).
//   4. --explain adds a `tried` array to data.
//   5. remap loads <cwd>/baton.config.json, resolves every role, and returns an
//      assignments entry per role carrying {platform, model, mode, chainIndex};
//      a missing config exits 1 with an error naming baton.config.json.
//   6. STRUCTURED ERROR TYPE (fold C1-5). `--structured-error-type <type>` is the
//      CLI surface for a hook-supplied structured StopFailure/exec-json error
//      type (there is no auth TEXT signature in the shipped table, so auth can
//      only be reached structured-first). detect classifies it structured-first,
//      overriding text/exit: authentication_failed -> auth -> exit 12;
//      rate_limit -> usage-limit -> exit 10.
//   7. OVERLAY HOT-PATCH (fold C1-5). `--signatures <path>` overlays the built-in
//      table (later-wins by id). A newly-overlaid usage-limit substring for a
//      platform classifies usage-limit -> exit 10 at spawn altitude, where the
//      same text without the overlay does NOT.
//
// The whole file is RED until detect/remap (and the signatures data table they
// consume) land: the correct red is an exit-code / envelope-field mismatch
// against today's shared "not implemented yet" (exit 1) placeholder.
// ===========================================================================

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const bin = join(repoRoot, 'core', 'bin', 'baton.mjs');

function runBaton(args, cwd = repoRoot) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
}

// The --json envelope contract is byte-exact: exactly one COMPACT single-line
// JSON value followed by a single '\n' on stdout — nothing else. Re-serialising
// the parsed value in compact form and comparing to raw stdout enforces "no
// pretty-printing, no leading/trailing whitespace, no diagnostics on stdout" all
// at once, then returns the parsed envelope for field assertions.
function parseEnvelope(r) {
  const parsed = JSON.parse(r.stdout);
  assert.equal(r.stdout, JSON.stringify(parsed) + '\n', 'stdout must be exactly one compact envelope + newline');
  assert.ok('ok' in parsed && 'data' in parsed && 'warnings' in parsed && 'error' in parsed,
    'envelope must carry ok/data/warnings/error');
  return parsed;
}

// Verified verbatim strings (see platform-notes.md); the "·" is U+00B7.
const SESSION_LIMIT = "You've hit your session limit · resets 3:45pm";
const SESSION_LIMIT_TZ = "You've hit your session limit · resets 2am (Asia/Dubai)";
const THROTTLE = 'API Error: Server is temporarily limiting requests (not your usage limit)';
const UNMATCHED = 'the quick brown fox jumps over the lazy dog';

// ---------------------------------------------------------------------------
describe('baton detect (integration, spawn)', () => {
  it('claude-code session-limit text -> exit 10, one compact envelope, class usage-limit, resetHint "3:45pm"', () => {
    const r = runBaton(['detect', '--platform', 'claude-code', '--text', SESSION_LIMIT, '--json']);
    assert.equal(r.status, 10, `usage-limit must exit 10; got ${r.status} (stderr: ${r.stderr})`);
    const env = parseEnvelope(r);
    assert.equal(env.data.class, 'usage-limit');
    assert.ok(
      typeof env.data.resetHint === 'string' && env.data.resetHint.includes('3:45pm'),
      `resetHint must contain "3:45pm"; got ${JSON.stringify(env.data.resetHint)}`,
    );
  });

  it('real-world timezone-suffixed reset hint -> exit 10, resetHint contains "2am (Asia/Dubai)"', () => {
    // Live capture 2026-07-12 (platform-notes.md §16): a session-limit reset hint
    // can carry a parenthesised timezone suffix; the extractor must keep it.
    const r = runBaton(['detect', '--platform', 'claude-code', '--text', SESSION_LIMIT_TZ, '--json']);
    assert.equal(r.status, 10, `usage-limit must exit 10; got ${r.status} (stderr: ${r.stderr})`);
    const env = parseEnvelope(r);
    assert.equal(env.data.class, 'usage-limit');
    assert.ok(
      typeof env.data.resetHint === 'string' && env.data.resetHint.includes('2am (Asia/Dubai)'),
      `timezone-suffixed resetHint must contain "2am (Asia/Dubai)"; got ${JSON.stringify(env.data.resetHint)}`,
    );
  });

  it('throttle text -> exit 11, class throttle (the "not your usage limit" parenthetical is NOT usage-limit)', () => {
    const r = runBaton(['detect', '--platform', 'claude-code', '--text', THROTTLE, '--json']);
    assert.equal(r.status, 11, `throttle must exit 11; got ${r.status} (stderr: ${r.stderr})`);
    const env = parseEnvelope(r);
    assert.equal(env.data.class, 'throttle');
    assert.notEqual(env.data.class, 'usage-limit');
  });

  it('unmatched text + --exit-code 1 -> exit 13, class other-error (generic nonzero is NEVER usage-limit)', () => {
    const r = runBaton(['detect', '--platform', 'claude-code', '--text', UNMATCHED, '--exit-code', '1', '--json']);
    assert.equal(r.status, 13, `unmatched nonzero must exit 13 (other-error); got ${r.status} (stderr: ${r.stderr})`);
    const env = parseEnvelope(r);
    assert.equal(env.data.class, 'other-error');
    assert.notEqual(env.data.class, 'usage-limit');
  });

  it('unmatched text + --exit-code 0 -> exit 0, class ok', () => {
    const r = runBaton(['detect', '--platform', 'claude-code', '--text', UNMATCHED, '--exit-code', '0', '--json']);
    assert.equal(r.status, 0, `unmatched zero exit must exit 0 (ok); got ${r.status} (stderr: ${r.stderr})`);
    const env = parseEnvelope(r);
    assert.equal(env.data.class, 'ok');
  });

  it('--explain adds a `tried` array to data', () => {
    const r = runBaton(['detect', '--platform', 'claude-code', '--text', SESSION_LIMIT, '--explain', '--json']);
    assert.equal(r.status, 10, `usage-limit must exit 10; got ${r.status} (stderr: ${r.stderr})`);
    const env = parseEnvelope(r);
    assert.equal(env.data.class, 'usage-limit');
    assert.ok(Array.isArray(env.data.tried), `--explain must add a tried array to data; got ${JSON.stringify(env.data.tried)}`);
  });

  it('--structured-error-type authentication_failed --platform claude-code -> exit 12, class auth (fold C1-5)', () => {
    // There is NO claude-code auth TEXT signature in the shipped table; auth is
    // only reachable via a hook-supplied structured error type. --structured-error-type
    // is the CLI surface for that, and it maps structured-first to auth -> exit 12.
    const r = runBaton(['detect', '--platform', 'claude-code', '--structured-error-type', 'authentication_failed', '--json']);
    assert.equal(r.status, 12, `auth must exit 12; got ${r.status} (stderr: ${r.stderr})`);
    const env = parseEnvelope(r);
    assert.equal(env.data.class, 'auth');
    assert.notEqual(env.data.class, 'usage-limit');
  });

  it('--structured-error-type rate_limit --platform claude-code -> exit 10, class usage-limit (fold C1-5)', () => {
    const r = runBaton(['detect', '--platform', 'claude-code', '--structured-error-type', 'rate_limit', '--json']);
    assert.equal(r.status, 10, `structured rate_limit must exit 10; got ${r.status} (stderr: ${r.stderr})`);
    const env = parseEnvelope(r);
    assert.equal(env.data.class, 'usage-limit');
  });

  it('--signatures <overlay> hot-patches a new cursor usage-limit substring -> exit 10 for the custom string (fold C1-5)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baton-sig-overlay-'));
    try {
      const overlay = {
        schema: 'baton/signatures@1',
        updated: '2026-07-12',
        signatures: [
          {
            id: 'cursor/custom-usage',
            platform: 'cursor',
            class: 'usage-limit',
            confidence: 'high',
            matcher: { kind: 'substring', value: 'CUSTOM CURSOR QUOTA EXHAUSTED' },
          },
        ],
      };
      const overlayPath = join(dir, 'overlay.json');
      writeFileSync(overlayPath, JSON.stringify(overlay));

      const CUSTOM = 'error: CUSTOM CURSOR QUOTA EXHAUSTED now';

      // Control: without the overlay the custom string is unknown -> NOT usage-limit
      // (default exit-code 0 -> ok, not exit 10). This gives the overlay teeth.
      const control = runBaton(['detect', '--platform', 'cursor', '--text', CUSTOM, '--json']);
      assert.notEqual(control.status, 10, `without the overlay the custom string must NOT be usage-limit; got ${control.status}`);

      // With the overlay, the newly-added substring classifies usage-limit -> exit 10.
      const r = runBaton(['detect', '--platform', 'cursor', '--text', CUSTOM, '--signatures', overlayPath, '--json']);
      assert.equal(r.status, 10, `overlaid custom usage-limit string must exit 10; got ${r.status} (stderr: ${r.stderr})`);
      const env = parseEnvelope(r);
      assert.equal(env.data.class, 'usage-limit');
      assert.equal(env.data.signatureId, 'cursor/custom-usage');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// A small fixture mirroring the repo-root baton.config.json shape: 3 roles,
// three platforms, defaults. With a bare `remap --to codex` (no origin death,
// so avoid=[]) every role resolves — codex entries native, others delegated.
function writeConfigFixture(dir) {
  const config = {
    schema: 'baton/config@1',
    roles: {
      planner: ['claude-code/claude-fable-5'],
      'test-author': ['claude-code/claude-opus-4-8', 'codex/gpt-5.5@xhigh'],
      implementer: ['codex/gpt-5.6-sol@xhigh', 'cursor/composer'],
    },
    platforms: { 'claude-code': {}, codex: {}, cursor: {} },
    defaults: { 'claude-code': 'claude-fable-5', codex: 'gpt-5.6-sol', cursor: 'composer' },
  };
  writeFileSync(join(dir, 'baton.config.json'), JSON.stringify(config, null, 2));
  return config;
}

describe('baton remap (integration, spawn)', () => {
  it('--to codex in a dir with baton.config.json -> exit 0, an assignments entry per role with {platform, model, mode, chainIndex}', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'baton-remap-'));
    try {
      const config = writeConfigFixture(cwd);
      const r = runBaton(['remap', '--to', 'codex', '--json'], cwd);
      assert.equal(r.status, 0, `remap with a valid config must exit 0; got ${r.status} (stderr: ${r.stderr})`);

      const env = parseEnvelope(r);
      assert.equal(env.ok, true);
      const assignments = env.data.assignments;
      assert.ok(assignments && typeof assignments === 'object', 'data.assignments must be an object');

      // Exactly one assignment per configured role.
      assert.deepEqual(Object.keys(assignments), Object.keys(config.roles), 'one assignment per configured role, in config order');

      for (const [role, a] of Object.entries(assignments)) {
        for (const key of ['platform', 'model', 'mode', 'chainIndex']) {
          assert.ok(key in a, `${role}.${key} must be present in the assignment`);
        }
        assert.ok(
          ['native', 'delegated', 'forced-default', 'unavailable'].includes(a.mode),
          `${role}.mode invalid: ${a.mode}`,
        );
      }

      // Teeth: with to=codex and avoid=[], a codex-first chain resolves native to
      // codex; a claude-code-only chain resolves delegated.
      assert.equal(assignments.implementer.mode, 'native');
      assert.equal(assignments.implementer.platform, 'codex');
      assert.equal(assignments.implementer.chainIndex, 0);
      assert.equal(assignments.planner.mode, 'delegated');
      assert.equal(assignments.planner.platform, 'claude-code');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('--to codex in an empty dir -> exit 1 with an error naming baton.config.json', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'baton-remap-empty-'));
    try {
      const r = runBaton(['remap', '--to', 'codex', '--json'], cwd);
      assert.equal(r.status, 1, `missing config must be a command failure (exit 1); got ${r.status}`);

      const env = parseEnvelope(r);
      assert.equal(env.ok, false);
      assert.ok(env.error, 'a missing-config failure must carry an error');
      // The message must name the file the user has to create — asserted against
      // the whole envelope so it holds whether it lands in error.msg or warnings.
      assert.match(r.stdout, /baton\.config\.json/, 'the error must name baton.config.json');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
