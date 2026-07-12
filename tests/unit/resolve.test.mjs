import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoles } from '../../core/src/roles/resolve.mjs';

// ===========================================================================
// Contract choices for roles/resolve.mjs. Source of truth: docs/design/core.md
// §Module APIs (resolveRoles signature + assignment shape); plan §Core engine —
// Role matrix + Availability probing (capability/outcome dimensions, avoid[],
// native/delegated/forced-default/unavailable, chainIndex + skipped audit data).
// resolveRoles is PURE and explainable.
//
// INPUT: resolveRoles({config, to, avoid = [], nativeOnly = false, probes = null}).
//   `config` is the PARSED config (roles as arrays of {platform, model, effort},
//   as loadConfig returns) — built inline here so this file's red phase is
//   attributable to resolve.mjs alone (not matrix.mjs).
//
// RETURN: { assignments: {[role]: Assignment}, notes: [] }.
//   Assignment = {platform, model, effort, mode, chainIndex, skipped[], degraded?}.
//   modes: 'native' | 'delegated' | 'forced-default' | 'unavailable'.
//
// PINS:
//   1. CHAIN WALK. For each role, walk entries in order; the FIRST eligible
//      (surviving) entry is selected. skipped[] records each passed-over entry
//      as {chainIndex, platform, model, why} (extra fields tolerated).
//      why values: 'avoided' | 'unknown-platform' | 'disabled' | 'rate-limited' | 'unauthenticated'.
//   2. ELIGIBILITY / skip reasons:
//        - platform ∈ avoid                          -> skip, why 'avoided'
//        - platform NOT a key of config.platforms    -> skip, why 'unknown-platform'
//        - config.platforms[p].enabled === false     -> skip, why 'disabled'
//        - probes given & probes[p].outcome==='rate-limited' -> skip, why 'rate-limited'
//        - probes given & capability==='installed' AND outcome!=='ok' (a VERIFIED
//          auth/reachability FAILURE)                 -> skip, why 'unauthenticated'
//          (iter-3 F1: a capped SUCCESS {installed, ok} leaves auth UNVERIFIED —
//          it stays selectable and is flagged degraded, it is NOT skipped)
//      A platform with capability ∈ {authenticated, reachable} AND outcome
//      ≠ 'rate-limited' is eligible.
//   3. DEGRADED. If probes is a non-null object but has NO entry for the chosen
//      platform (unverifiable), the entry is selectable with degraded === true.
//      probes === null means OFFLINE resolution: still selectable, but every
//      selection is flagged degraded (gate-2 iter-2 M3; plan: offline always degraded).
//      Non-degraded assignments have a falsy `degraded` (absent or false).
//   4. MODE. First surviving entry: mode 'native' iff entry.platform === to,
//      else 'delegated'. chainIndex = that entry's index in the ORIGINAL chain.
//   5. nativeOnly restricts consideration to entries with platform === to; if
//      none survive it MAY fall back to config.defaults[to] with mode
//      'forced-default' (platform=to, model=defaults[to], effort=null,
//      chainIndex=null) — but ONLY when the destination `to` is itself
//      probe-eligible (PIN 2). When `to` is probe-INELIGIBLE (e.g. rate-limited),
//      the forced-default is SUPPRESSED and the role resolves 'unavailable', the
//      ineligibility audited in skipped[] (why 'rate-limited'). (fold C1-1)
//   6. UNAVAILABLE. In normal (non-nativeOnly) mode, when NOTHING survives:
//      mode 'unavailable', platform null, model null, effort null,
//      chainIndex null, and skipped[] carries the full passed-over list.
//   7. DETERMINISM. Same input -> deep-equal output; input config is not mutated.
//      assignments object keys are in the CONFIG'S ROLE ORDER.
//   8. avoid[] auto-population is the CALLER'S job; resolve only honors the list.
// ===========================================================================

const e = (platform, model, effort = null) => ({ platform, model, effort });

const PLATFORMS = { 'claude-code': {}, codex: {}, cursor: {} };
const DEFAULTS = { 'claude-code': 'claude-fable-5', codex: 'gpt-5.6-sol', cursor: 'composer' };

// The full seven-role config in parsed form (mirrors the real baton.config.json).
function fullConfig() {
  return {
    schema: 'baton/config@1',
    roles: {
      planner: [e('claude-code', 'claude-fable-5')],
      'plan-reviewer': [e('codex', 'gpt-5.6-sol', 'xhigh'), e('claude-code', 'claude-fable-5', 'xhigh')],
      'test-author': [e('claude-code', 'claude-opus-4-8'), e('codex', 'gpt-5.5', 'xhigh')],
      'test-verifier': [e('codex', 'gpt-5.5', 'xhigh'), e('claude-code', 'claude-opus-4-8')],
      implementer: [e('claude-code', 'claude-fable-5'), e('codex', 'gpt-5.6-sol', 'xhigh'), e('cursor', 'composer')],
      'final-reviewer-a': [e('codex', 'gpt-5.6-sol', 'xhigh'), e('codex', 'gpt-5.5', 'xhigh')],
      'final-reviewer-b': [e('claude-code', 'claude-fable-5', 'xhigh'), e('claude-code', 'claude-opus-4-8')],
    },
    platforms: { ...PLATFORMS },
    defaults: { ...DEFAULTS },
  };
}

// A small single-role config helper.
function oneRole(chain) {
  return { schema: 'baton/config@1', roles: { r: chain }, platforms: { ...PLATFORMS }, defaults: { ...DEFAULTS } };
}

// ---------------------------------------------------------------------------
describe('resolveRoles — canonical usage-limit failover (claude-code -> codex)', () => {
  it('maps every role for to=codex, avoid=[claude-code] with correct modes/chainIndex/skips', () => {
    const config = fullConfig();
    const { assignments } = resolveRoles({ config, to: 'codex', avoid: ['claude-code'] });

    // planner: only entry is claude-code (avoided) -> unavailable.
    assert.equal(assignments.planner.mode, 'unavailable');
    assert.equal(assignments.planner.platform, null);
    assert.equal(assignments.planner.model, null);
    assert.equal(assignments.planner.chainIndex, null);
    assert.equal(assignments.planner.skipped.length, 1);
    assert.equal(assignments.planner.skipped[0].why, 'avoided');
    assert.equal(assignments.planner.skipped[0].platform, 'claude-code');

    // plan-reviewer: codex is entry 0 -> native, no skips.
    assert.deepEqual(pick(assignments['plan-reviewer']), {
      platform: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh', mode: 'native', chainIndex: 0,
    });
    assert.equal(assignments['plan-reviewer'].skipped.length, 0);

    // test-author: claude-code(0) avoided -> codex(1) native.
    assert.deepEqual(pick(assignments['test-author']), {
      platform: 'codex', model: 'gpt-5.5', effort: 'xhigh', mode: 'native', chainIndex: 1,
    });
    assert.equal(assignments['test-author'].skipped.length, 1);
    assert.equal(assignments['test-author'].skipped[0].why, 'avoided');
    assert.equal(assignments['test-author'].skipped[0].chainIndex, 0);

    // test-verifier: codex(0) native.
    assert.deepEqual(pick(assignments['test-verifier']), {
      platform: 'codex', model: 'gpt-5.5', effort: 'xhigh', mode: 'native', chainIndex: 0,
    });

    // implementer: claude-code(0) avoided -> codex(1) native.
    assert.deepEqual(pick(assignments.implementer), {
      platform: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh', mode: 'native', chainIndex: 1,
    });

    // final-reviewer-a: codex(0) native.
    assert.deepEqual(pick(assignments['final-reviewer-a']), {
      platform: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh', mode: 'native', chainIndex: 0,
    });

    // final-reviewer-b: both entries claude-code (avoided) -> unavailable.
    assert.equal(assignments['final-reviewer-b'].mode, 'unavailable');
    assert.equal(assignments['final-reviewer-b'].skipped.length, 2);
    assert.ok(assignments['final-reviewer-b'].skipped.every((s) => s.why === 'avoided'));
  });

  function pick(a) {
    return { platform: a.platform, model: a.model, effort: a.effort, mode: a.mode, chainIndex: a.chainIndex };
  }
});

// ---------------------------------------------------------------------------
describe('resolveRoles — mode selection', () => {
  it('native: first surviving entry whose platform === to', () => {
    const { assignments } = resolveRoles({ config: oneRole([e('codex', 'gpt-5.5', 'xhigh')]), to: 'codex' });
    assert.equal(assignments.r.mode, 'native');
    assert.equal(assignments.r.platform, 'codex');
    assert.equal(assignments.r.chainIndex, 0);
  });

  it('delegated: first surviving entry whose platform !== to', () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('claude-code', 'claude-fable-5'), e('cursor', 'composer')]),
      to: 'cursor',
    });
    assert.equal(assignments.r.mode, 'delegated');
    assert.equal(assignments.r.platform, 'claude-code');
    assert.equal(assignments.r.model, 'claude-fable-5');
    assert.equal(assignments.r.chainIndex, 0);
  });

  it('unavailable: normal mode, every entry skipped -> platform/model null, full skipped[], NO forced default', () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('claude-code', 'claude-fable-5'), e('codex', 'gpt-5.5', 'xhigh')]),
      to: 'codex',
      avoid: ['claude-code', 'codex'],
    });
    assert.equal(assignments.r.mode, 'unavailable');
    assert.equal(assignments.r.platform, null);
    assert.equal(assignments.r.model, null);
    assert.equal(assignments.r.effort, null);
    assert.equal(assignments.r.chainIndex, null);
    assert.equal(assignments.r.skipped.length, 2);
  });
});

// ---------------------------------------------------------------------------
describe('resolveRoles — nativeOnly + forced-default', () => {
  it('nativeOnly picks a native entry, skipping delegated ones', () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('claude-code', 'claude-fable-5'), e('codex', 'gpt-5.6-sol', 'xhigh')]),
      to: 'codex',
      nativeOnly: true,
    });
    assert.equal(assignments.r.mode, 'native');
    assert.equal(assignments.r.platform, 'codex');
    assert.equal(assignments.r.chainIndex, 1);
  });

  it('nativeOnly with no native entry falls back to defaults[to] as forced-default (no probing)', () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('claude-code', 'claude-fable-5')]),
      to: 'codex',
      nativeOnly: true,
    });
    assert.equal(assignments.r.mode, 'forced-default');
    assert.equal(assignments.r.platform, 'codex');
    assert.equal(assignments.r.model, 'gpt-5.6-sol'); // defaults.codex
    assert.equal(assignments.r.effort, null);
    assert.equal(assignments.r.chainIndex, null);
  });

  it('nativeOnly forced-default requires the destination `to` to be probe-ELIGIBLE (authenticated/ok)', () => {
    // No native codex entry in the chain, but codex (the destination) is probed
    // eligible -> the forced-default IS selectable. This ties the forced-default
    // fallback to destination probe-eligibility (fold C1-1).
    const { assignments } = resolveRoles({
      config: oneRole([e('claude-code', 'claude-fable-5')]),
      to: 'codex',
      nativeOnly: true,
      probes: { codex: { capability: 'authenticated', outcome: 'ok' } },
    });
    assert.equal(assignments.r.mode, 'forced-default');
    assert.equal(assignments.r.platform, 'codex');
    assert.equal(assignments.r.model, 'gpt-5.6-sol');
    assert.equal(assignments.r.effort, null);
    assert.equal(assignments.r.chainIndex, null);
  });

  it('nativeOnly: the only native entry (=to) is rate-limited -> forced-default SUPPRESSED, unavailable with a rate-limited skip', () => {
    // The destination platform itself is rate-limited, so forcing its default is
    // not valid: the role resolves 'unavailable', and the passed-over rate-limited
    // entry is audited in skipped[] with why 'rate-limited' (fold C1-1, replaces
    // the earlier test that wrongly selected a rate-limited forced-default).
    const { assignments } = resolveRoles({
      config: oneRole([e('codex', 'gpt-5.6-sol', 'xhigh')]),
      to: 'codex',
      nativeOnly: true,
      probes: { codex: { capability: 'authenticated', outcome: 'rate-limited' } },
    });
    assert.equal(assignments.r.mode, 'unavailable');
    assert.equal(assignments.r.platform, null);
    assert.equal(assignments.r.model, null);
    assert.equal(assignments.r.effort, null);
    assert.equal(assignments.r.chainIndex, null);
    const rl = assignments.r.skipped.find((s) => s.why === 'rate-limited' && s.platform === 'codex');
    assert.ok(rl, 'the rate-limited destination entry must be audited in skipped[] with why "rate-limited"');
  });
});

// ---------------------------------------------------------------------------
describe('resolveRoles — skip reasons', () => {
  it("unknown platform (absent from config.platforms) -> skip, why 'unknown-platform'", () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('ghost', 'x'), e('codex', 'gpt-5.5', 'xhigh')]),
      to: 'codex',
    });
    assert.equal(assignments.r.platform, 'codex');
    assert.equal(assignments.r.chainIndex, 1);
    assert.equal(assignments.r.skipped[0].why, 'unknown-platform');
    assert.equal(assignments.r.skipped[0].platform, 'ghost');
  });

  it("probe outcome 'rate-limited' -> skip, why 'rate-limited'", () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('codex', 'a'), e('cursor', 'b')]),
      to: 'cursor',
      probes: { codex: { capability: 'reachable', outcome: 'rate-limited' }, cursor: { capability: 'reachable', outcome: 'ok' } },
    });
    assert.equal(assignments.r.platform, 'cursor');
    assert.equal(assignments.r.chainIndex, 1);
    assert.equal(assignments.r.skipped[0].why, 'rate-limited');
    assert.equal(assignments.r.skipped[0].platform, 'codex');
  });

  it("capability 'installed' with a capped SUCCESS -> selectable + degraded, not skipped (iter-3 F1)", () => {
    // A --version success caps capability at 'installed' but leaves auth
    // UNVERIFIED (not verified-failed), so the platform stays selectable and is
    // flagged degraded — per plan §Role matrix. Only a verified failure skips.
    const { assignments } = resolveRoles({
      config: oneRole([e('codex', 'a'), e('cursor', 'b')]),
      to: 'cursor',
      probes: { codex: { capability: 'installed', outcome: 'ok' }, cursor: { capability: 'authenticated', outcome: 'ok' } },
    });
    assert.equal(assignments.r.platform, 'codex', 'auth-unverified codex stays selectable at chain head');
    assert.equal(assignments.r.degraded, true, 'the auth-unverified selection is flagged degraded');
    assert.equal(assignments.r.skipped.length, 0);
  });

  it("capability 'installed' with a VERIFIED failure -> skip, why 'unauthenticated' (iter-3 F1)", () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('codex', 'a'), e('cursor', 'b')]),
      to: 'cursor',
      probes: { codex: { capability: 'installed', outcome: 'error' }, cursor: { capability: 'authenticated', outcome: 'ok' } },
    });
    assert.equal(assignments.r.platform, 'cursor');
    assert.equal(assignments.r.skipped[0].why, 'unauthenticated');
    assert.equal(assignments.r.skipped[0].platform, 'codex');
  });

  it("a platform configured { enabled: false } is skipped, why 'disabled' (no probes needed) (fold C1-6)", () => {
    // The disabled shape is config.platforms[p] = { enabled: false }. It is a KEY
    // of config.platforms (so NOT 'unknown-platform'), but explicitly disabled, so
    // it is skipped with why 'disabled' — distinct from avoid[]/rate-limited.
    const { assignments } = resolveRoles({
      config: {
        schema: 'baton/config@1',
        roles: { r: [e('codex', 'a'), e('cursor', 'b')] },
        platforms: { 'claude-code': {}, codex: { enabled: false }, cursor: {} },
        defaults: { ...DEFAULTS },
      },
      to: 'cursor',
    });
    assert.equal(assignments.r.platform, 'cursor');
    assert.equal(assignments.r.chainIndex, 1);
    assert.equal(assignments.r.skipped.length, 1);
    assert.equal(assignments.r.skipped[0].why, 'disabled');
    assert.equal(assignments.r.skipped[0].platform, 'codex');
  });

  it("an { enabled: true } (or bare {}) platform is NOT disabled — only enabled===false disables", () => {
    // Guards against the implementer treating any non-empty platform config as a
    // disable signal: enabled:true must remain eligible.
    const { assignments } = resolveRoles({
      config: {
        schema: 'baton/config@1',
        roles: { r: [e('codex', 'a')] },
        platforms: { 'claude-code': {}, codex: { enabled: true }, cursor: {} },
        defaults: { ...DEFAULTS },
      },
      to: 'codex',
    });
    assert.equal(assignments.r.mode, 'native');
    assert.equal(assignments.r.platform, 'codex');
    assert.equal(assignments.r.skipped.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('resolveRoles — probe eligibility & degraded flag', () => {
  it("capability 'authenticated' + outcome 'ok' is eligible and NOT degraded", () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('codex', 'a')]),
      to: 'codex',
      probes: { codex: { capability: 'authenticated', outcome: 'ok' } },
    });
    assert.equal(assignments.r.mode, 'native');
    assert.equal(assignments.r.platform, 'codex');
    assert.ok(!assignments.r.degraded, 'a verified authenticated/ok platform must not be degraded');
  });

  it("capability 'reachable' + outcome 'ok' is eligible and NOT degraded", () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('codex', 'a')]),
      to: 'codex',
      probes: { codex: { capability: 'reachable', outcome: 'ok' } },
    });
    assert.ok(!assignments.r.degraded);
  });

  it('a chosen platform ABSENT from a non-null probes map is selectable but degraded:true', () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('codex', 'a')]),
      to: 'codex',
      probes: { cursor: { capability: 'reachable', outcome: 'ok' } }, // codex not probed
    });
    assert.equal(assignments.r.mode, 'native');
    assert.equal(assignments.r.platform, 'codex');
    assert.equal(assignments.r.degraded, true);
  });

  it('probes === null (offline) resolves eligible but flagged degraded (gate-2 iter-2 M3; plan: offline always degraded)', () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('codex', 'a')]),
      to: 'codex',
      probes: null,
    });
    assert.equal(assignments.r.mode, 'native', 'the platform is still selectable offline');
    assert.ok(assignments.r.degraded, 'offline resolution is flagged degraded — the weakening is auditable, never silent');
  });
});

// ---------------------------------------------------------------------------
describe('resolveRoles — determinism & shape', () => {
  it('same input -> deep-equal output across two calls', () => {
    const a = resolveRoles({ config: fullConfig(), to: 'codex', avoid: ['claude-code'] });
    const b = resolveRoles({ config: fullConfig(), to: 'codex', avoid: ['claude-code'] });
    assert.deepEqual(a, b);
  });

  it('does not mutate the input config', () => {
    const config = fullConfig();
    const snapshot = structuredClone(config);
    resolveRoles({ config, to: 'codex', avoid: ['claude-code'], probes: { codex: { capability: 'reachable', outcome: 'ok' } } });
    assert.deepEqual(config, snapshot, 'config must be left untouched');
  });

  it('assignments keys are in the config role order', () => {
    const config = fullConfig();
    const { assignments } = resolveRoles({ config, to: 'codex' });
    assert.deepEqual(Object.keys(assignments), Object.keys(config.roles));
  });

  it('every assignment carries the documented fields; notes is an array', () => {
    const { assignments, notes } = resolveRoles({ config: fullConfig(), to: 'codex', avoid: ['claude-code'] });
    assert.ok(Array.isArray(notes), 'notes must be an array');
    for (const [role, a] of Object.entries(assignments)) {
      for (const key of ['platform', 'model', 'effort', 'mode', 'chainIndex', 'skipped']) {
        assert.ok(key in a, `${role}.${key} must be present`);
      }
      assert.ok(Array.isArray(a.skipped), `${role}.skipped must be an array`);
      assert.ok(['native', 'delegated', 'forced-default', 'unavailable'].includes(a.mode), `${role}.mode invalid: ${a.mode}`);
    }
  });
});
