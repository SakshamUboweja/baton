import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoles } from '../../core/src/roles/resolve.mjs';

// ---------------------------------------------------------------------------
// RED — resolver entry-level avoidance (subtask l1-resolver-entries, part A).
//
// Source of truth: docs/plans/2026-07-18-goal-loop-worktree-pipeline.md
//   §"Model-level failover (Gate-1 iteration 1, finding 4)" and
//   §"Acceptance constraints" constraint 2; docs/design/core.md §Module APIs
//   (resolveRoles). Mirrors the idioms in tests/unit/resolve.test.mjs.
//
// CONTRACT (pinned here):
//   A1. NEW OPT. resolveRoles opts gain `avoidEntries: [{platform, model}]`,
//       alongside the existing platform-level `avoid[]`. A chain entry is
//       skipped by this rule ONLY when BOTH platform AND model match an
//       avoidEntries item — a different model on the same platform stays
//       selectable (that is the whole point: model-level, not platform-level).
//   A2. AUDIT. An entry-avoided skip is recorded in skipped[] with a DISTINCT
//       why: 'avoided-entry' (mirrors the existing skip-recording idiom:
//       {chainIndex, platform, model, why}). The platform-level rule keeps its
//       own why 'avoided' — the two are never conflated.
//   A3. NAMED TEST (constraint 2). A chain whose first entry is codex/<A> and
//       second codex/<B>, with avoidEntries [{platform:'codex', model:'<A>'}],
//       selects <B> on the SAME platform (mode stays native), with no
//       platform-wide avoidance.
//   A4. COMPOSITION. avoidEntries composes with avoid[]: an entry on an AVOIDED
//       PLATFORM is skipped by the platform rule (why 'avoided'); entry
//       avoidance never resurrects a platform-avoided entry.
//   A5. EFFORT SUFFIX. Config chain strings are "platform/model[@effort]"
//       (matrix.mjs parses model + effort apart). avoidEntries matches on MODEL
//       IDENTITY regardless of any @effort suffix — model is what's
//       unavailable, not a specific effort. So an avoidEntries model carrying an
//       @effort suffix matches a parsed entry of the same base model, and effort
//       differences never prevent (or force) a match.
//   A6. EXHAUSTION. All entries avoided → the existing 'unavailable' path fires
//       (platform/model null, full skipped[]), never a crash.
//   A7. BACKWARD COMPAT. Omitted OR empty avoidEntries → behavior identical to
//       today (regression negatives, GREEN both today and after).
//
// PROOF-OF-RED: avoidEntries does not exist yet, so resolveRoles ignores it and
// selects the FIRST platform-eligible entry. The RED tests assert the
// entry-avoided selection / skip audit, which fails today (the avoided entry is
// still chosen). Tests labeled GREEN are invariants that hold both today and
// after and guard against over-broad matching.
// ---------------------------------------------------------------------------

const e = (/** @type {string} */ platform, /** @type {string} */ model, /** @type {string | null} */ effort = null) => ({ platform, model, effort });
const PLATFORMS = { 'claude-code': {}, codex: {}, cursor: {} };
const DEFAULTS = { 'claude-code': 'claude-fable-5', codex: 'gpt-5.6-sol', cursor: 'composer' };
const oneRole = (/** @type {any[]} */ chain) => ({ schema: 'baton/config@1', roles: { r: chain }, platforms: { ...PLATFORMS }, defaults: { ...DEFAULTS } });

// ===========================================================================
describe('resolveRoles — entry-level avoidance: the named same-platform-next-entry test (A3)', () => {
  it('RED: codex/<A> avoided → codex/<B> selected on the SAME platform, mode native, no platform-wide avoidance', () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('codex', 'gpt-5.5', 'xhigh'), e('codex', 'gpt-5.6-sol', 'xhigh')]),
      to: 'codex',
      avoidEntries: [{ platform: 'codex', model: 'gpt-5.5' }],
    });
    assert.equal(assignments.r.platform, 'codex', 'the SAME platform stays selectable');
    assert.equal(assignments.r.model, 'gpt-5.6-sol', 'the next MODEL on that platform is chosen');
    assert.equal(assignments.r.mode, 'native', 'mode stays native (no platform failover)');
    assert.equal(assignments.r.chainIndex, 1);
  });

  it('RED: real-world order — first entry codex/gpt-5.6-sol avoided → codex/gpt-5.5 selected on the same platform (finding 4)', () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('codex', 'gpt-5.6-sol', 'xhigh'), e('codex', 'gpt-5.5', 'xhigh')]),
      to: 'codex',
      avoidEntries: [{ platform: 'codex', model: 'gpt-5.6-sol' }],
    });
    assert.equal(assignments.r.platform, 'codex');
    assert.equal(assignments.r.model, 'gpt-5.5', 'the next model on the same platform is chosen');
    assert.equal(assignments.r.chainIndex, 1);
    assert.equal(assignments.r.mode, 'native');
  });

  it('RED: the passed-over entry is audited in skipped[] with why "avoided-entry"', () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('codex', 'gpt-5.5', 'xhigh'), e('codex', 'gpt-5.6-sol', 'xhigh')]),
      to: 'codex',
      avoidEntries: [{ platform: 'codex', model: 'gpt-5.5' }],
    });
    const skip = assignments.r.skipped.find((/** @type {any} */ s) => s.why === 'avoided-entry');
    assert.ok(skip, 'a distinct why "avoided-entry" records the entry-level skip');
    assert.equal(skip.platform, 'codex');
    assert.equal(skip.model, 'gpt-5.5');
    assert.equal(skip.chainIndex, 0);
  });
});

// ===========================================================================
describe('resolveRoles — entry avoidance is MODEL-specific, not platform-wide (A1)', () => {
  it('GREEN guard: avoidEntries for a DIFFERENT model on the platform does NOT skip the head entry', () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('codex', 'gpt-5.5', 'xhigh'), e('codex', 'gpt-5.6-sol', 'xhigh')]),
      to: 'codex',
      avoidEntries: [{ platform: 'codex', model: 'gpt-5.6-sol' }],
    });
    assert.equal(assignments.r.model, 'gpt-5.5', 'a non-matching model avoidance must not skip a different model');
    assert.equal(assignments.r.chainIndex, 0);
    assert.ok(!assignments.r.skipped.some((/** @type {any} */ s) => s.why === 'avoided-entry'), 'no entry was avoided');
  });

  it('GREEN guard: reciprocal tuple match — the SAME model on a DIFFERENT platform is not avoided (kills a model-only comparison)', () => {
    // Two entries share the model string; avoidEntries targets it on the NON-head
    // platform. A tuple (platform AND model) match leaves the head selectable; a
    // model-only implementation would wrongly skip the head.
    const { assignments } = resolveRoles({
      config: oneRole([e('claude-code', 'shared-model'), e('codex', 'shared-model')]),
      to: 'claude-code',
      avoidEntries: [{ platform: 'codex', model: 'shared-model' }],
    });
    assert.equal(assignments.r.platform, 'claude-code', 'the head entry (different platform) stays selected');
    assert.equal(assignments.r.model, 'shared-model');
    assert.equal(assignments.r.chainIndex, 0);
    assert.ok(!assignments.r.skipped.some((/** @type {any} */ s) => s.why === 'avoided-entry'), 'the head is NOT entry-avoided (platform differs)');
  });
});

// ===========================================================================
describe('resolveRoles — composition with platform-level avoid[] (A4)', () => {
  it('RED: platform-avoided entry keeps why "avoided"; a same-platform entry-avoided one is skipped "avoided-entry"; the survivor is chosen', () => {
    const { assignments } = resolveRoles({
      config: oneRole([
        e('codex', 'gpt-5.5', 'xhigh'), // platform-avoided
        e('claude-code', 'claude-fable-5'), // entry-avoided
        e('claude-code', 'claude-opus-4-8'), // survivor
      ]),
      to: 'claude-code',
      avoid: ['codex'],
      avoidEntries: [{ platform: 'claude-code', model: 'claude-fable-5' }],
    });
    assert.equal(assignments.r.platform, 'claude-code');
    assert.equal(assignments.r.model, 'claude-opus-4-8', 'the entry-avoided model is NOT resurrected; the survivor is chosen');
    assert.equal(assignments.r.chainIndex, 2);

    const codexSkip = assignments.r.skipped.find((/** @type {any} */ s) => s.platform === 'codex');
    assert.equal(codexSkip.why, 'avoided', 'a platform-avoided entry keeps the platform rule why "avoided"');
    const entrySkip = assignments.r.skipped.find((/** @type {any} */ s) => s.platform === 'claude-code' && s.model === 'claude-fable-5');
    assert.equal(entrySkip.why, 'avoided-entry', 'the same-platform model-avoided entry uses why "avoided-entry"');
  });

  it('GREEN guard: an entry hit by BOTH avoid[] AND avoidEntries is labeled "avoided" — the platform rule wins the label (finding 3)', () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('codex', 'gpt-5.5', 'xhigh'), e('claude-code', 'claude-fable-5')]),
      to: 'claude-code',
      avoid: ['codex'],
      avoidEntries: [{ platform: 'codex', model: 'gpt-5.5' }], // same entry, both rules
    });
    assert.equal(assignments.r.platform, 'claude-code', 'the survivor is chosen');
    const codexSkip = assignments.r.skipped.find((/** @type {any} */ s) => s.platform === 'codex');
    assert.equal(codexSkip.why, 'avoided', 'a dual-matched entry keeps the platform-rule label "avoided", not "avoided-entry"');
  });
});

// ===========================================================================
describe('resolveRoles — avoidEntries model matches regardless of @effort suffix (A5)', () => {
  it('RED: an avoidEntries model carrying an @effort suffix matches the parsed base model', () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('codex', 'gpt-5.5', 'xhigh'), e('codex', 'gpt-5.6-sol', 'xhigh')]),
      to: 'codex',
      // The supervisor derived the entry from the raw "codex/gpt-5.5@xhigh" string.
      avoidEntries: [{ platform: 'codex', model: 'gpt-5.5@xhigh' }],
    });
    assert.equal(assignments.r.model, 'gpt-5.6-sol', 'the @effort suffix on the avoid model is ignored — the base model matches');
    assert.equal(assignments.r.chainIndex, 1);
  });

  it('RED: effort DIFFERENCES never prevent a match — model identity is what is unavailable', () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('codex', 'gpt-5.5', 'xhigh'), e('codex', 'gpt-5.6-sol', 'xhigh')]),
      to: 'codex',
      avoidEntries: [{ platform: 'codex', model: 'gpt-5.5@minimal' }], // different effort suffix
    });
    assert.equal(assignments.r.model, 'gpt-5.6-sol', 'the entry is skipped despite the effort mismatch (base model matches)');
  });

  it('GREEN guard: a different base model with an @effort suffix still does NOT match', () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('codex', 'gpt-5.5', 'xhigh'), e('codex', 'gpt-5.6-sol', 'xhigh')]),
      to: 'codex',
      avoidEntries: [{ platform: 'codex', model: 'gpt-5.6-sol@xhigh' }],
    });
    assert.equal(assignments.r.model, 'gpt-5.5', 'a different base model is not skipped, effort suffix notwithstanding');
    assert.equal(assignments.r.chainIndex, 0);
  });
});

// ===========================================================================
describe('resolveRoles — exhaustion when all entries are avoided (A6)', () => {
  it('RED: every entry avoided → mode "unavailable" (platform/model null, full skipped[]), no crash', () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('codex', 'gpt-5.5'), e('codex', 'gpt-5.6-sol')]),
      to: 'codex',
      avoidEntries: [
        { platform: 'codex', model: 'gpt-5.5' },
        { platform: 'codex', model: 'gpt-5.6-sol' },
      ],
    });
    assert.equal(assignments.r.mode, 'unavailable');
    assert.equal(assignments.r.platform, null);
    assert.equal(assignments.r.model, null);
    assert.equal(assignments.r.skipped.length, 2);
    assert.ok(assignments.r.skipped.every((/** @type {any} */ s) => s.why === 'avoided-entry'), 'both skips are entry-avoidances');
  });
});

// ===========================================================================
describe('resolveRoles — backward compatibility (A7)', () => {
  it('GREEN guard: omitted avoidEntries behaves exactly as today', () => {
    const { assignments } = resolveRoles({
      config: oneRole([e('codex', 'gpt-5.5', 'xhigh'), e('codex', 'gpt-5.6-sol', 'xhigh')]),
      to: 'codex',
    });
    assert.equal(assignments.r.model, 'gpt-5.5', 'the head entry is chosen when no avoidance is supplied');
    assert.equal(assignments.r.skipped.length, 0);
  });

  it('GREEN guard: an EMPTY avoidEntries is identical to omitting it', () => {
    const config = () => oneRole([e('claude-code', 'claude-fable-5'), e('codex', 'gpt-5.6-sol', 'xhigh')]);
    const omitted = resolveRoles({ config: config(), to: 'codex', avoid: ['claude-code'] });
    const empty = resolveRoles({ config: config(), to: 'codex', avoid: ['claude-code'], avoidEntries: [] });
    assert.deepEqual(empty, omitted, 'empty avoidEntries changes nothing');
  });
});
