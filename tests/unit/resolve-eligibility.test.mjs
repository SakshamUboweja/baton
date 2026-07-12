import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoles } from '../../core/src/roles/resolve.mjs';

// ---------------------------------------------------------------------------
// Gate-2 iteration-3 F1 (reviewer-a #6, reviewer-b #1): doctor caps a healthy
// `claude --version` probe at capability 'installed' (capOnSuccess), so the
// probe cache doctor writes carries {capability:'installed', outcome:'ok'} for a
// fully healthy claude-code. A version probe leaves AUTH UNVERIFIED — not
// verified-failed — so the plan (§Role matrix) requires selectable-with-degraded,
// NOT skipped-as-unauthenticated. The resolver must only skip 'unauthenticated'
// on a VERIFIED auth failure (installed AND outcome !== 'ok').
// ---------------------------------------------------------------------------

const CONFIG = {
  schema: 'baton/config@1',
  roles: {
    ccFirst: [{ platform: 'claude-code', model: 'claude-fable-5' }, { platform: 'codex', model: 'gpt-5.6-sol' }],
    ccOnly: [{ platform: 'claude-code', model: 'claude-fable-5' }],
  },
  platforms: { 'claude-code': {}, codex: {}, cursor: {} },
  defaults: { 'claude-code': 'claude-fable-5', codex: 'gpt-5.6-sol', cursor: 'composer' },
};

// The exact cache shape doctor writes on a healthy machine: claude-code capped
// at 'installed' by capOnSuccess, codex/cursor probed to 'reachable'.
const HEALTHY_CACHE = {
  'claude-code': { capability: 'installed', outcome: 'ok' },
  codex: { capability: 'reachable', outcome: 'ok' },
  cursor: { capability: 'reachable', outcome: 'ok' },
};

describe('F1 — a healthy version-probed platform is selectable-but-degraded, not skipped', () => {
  it('claude-code {installed, ok} is SELECTED (degraded) where first-eligible, not skipped as unauthenticated', () => {
    const { assignments } = resolveRoles({ config: CONFIG, to: 'codex', probes: HEALTHY_CACHE });
    const cc = assignments.ccFirst;
    assert.equal(cc.platform, 'claude-code', 'a version-probed claude-code stays selectable at chain head');
    assert.equal(cc.degraded, true, 'auth-unverified selection carries the degraded flag');
    assert.ok(!(cc.skipped ?? []).some((/** @type {any} */ s) => s.platform === 'claude-code'), 'claude-code is not skipped');
  });

  it('a claude-code-only role resolves to claude-code (degraded), never "unavailable"', () => {
    const { assignments } = resolveRoles({ config: CONFIG, to: 'claude-code', probes: HEALTHY_CACHE });
    assert.equal(assignments.ccOnly.mode, 'native');
    assert.equal(assignments.ccOnly.platform, 'claude-code');
    assert.equal(assignments.ccOnly.degraded, true);
  });

  it('a VERIFIED auth/reachability failure ({installed, error}) IS skipped as unauthenticated', () => {
    const probes = { ...HEALTHY_CACHE, 'claude-code': { capability: 'installed', outcome: 'error' } };
    const { assignments } = resolveRoles({ config: CONFIG, to: 'codex', probes });
    const cc = assignments.ccFirst;
    assert.equal(cc.platform, 'codex', 'a verified-failed claude-code falls through to codex');
    assert.ok((cc.skipped ?? []).some((/** @type {any} */ s) => s.platform === 'claude-code' && s.why === 'unauthenticated'), 'recorded as unauthenticated');
  });

  it('a fully-reachable platform still resolves without a degraded flag', () => {
    const { assignments } = resolveRoles({ config: CONFIG, to: 'codex', probes: HEALTHY_CACHE });
    // codex is reachable+ok → the delegated pick for a codex-native role is not degraded.
    const codexPick = resolveRoles({ config: { ...CONFIG, roles: { r: [{ platform: 'codex', model: 'gpt-5.6-sol' }] } }, to: 'codex', probes: HEALTHY_CACHE }).assignments.r;
    assert.equal(codexPick.degraded ?? false, false, 'a reachable+ok platform is not degraded');
    assert.ok(assignments.ccFirst);
  });
});
