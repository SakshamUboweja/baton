import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// RED — loop spec module (subtask loop-spec, part A). FIRST new module: these
// tests DEFINE the API. Source of truth:
// docs/plans/2026-07-18-goal-loop-worktree-pipeline.md §"Loop spec",
// §"Role-matrix additions", §"baton loop".
//
// TARGET MODULE: core/src/loop/spec.mjs (pure), two exports:
//   defaultLoopSpec(goal) -> scaffold object
//   validateLoopSpec(spec, config) -> {ok:true, spec} | {ok:false, errors:[strings]}
//
// RED MECHANISM (coordinator guidance): dynamic import with catch, so each test
// reds on a MEANINGFUL assertion ("module must load") rather than a bare
// ERR_MODULE_NOT_FOUND crash. Once spec.mjs exists these pin its behavior.
//
// CONTRACT PINNED HERE:
//   defaultLoopSpec(goal):
//     - schema 'baton/loop@1'; goal echoed; constraints []; smoke {cmd:null, expect:null}
//     - phases: ordered {id, role} — plan(planner), gate-1(plan-reviewer),
//       smoke-tests(test-author), smoke-verify(test-verifier),
//       smoke-build(implementer), then the subtask cycle roles
//       (test-author, test-verifier, implementer, subtask-reviewer),
//       gate-2 twice (final-reviewer-a, final-reviewer-b). The ROLE SEQUENCE is
//       pinned exactly; the explicitly-named ids are pinned; loosely-named ids
//       (subtask cycle) are only required to be non-empty strings.
//     - budgets {iterationCap:5, perRoleTimeoutMin:30, maxChildrenPerPhase:10}
//   validateLoopSpec: rejections each NAME the offender; ALL problems reported;
//     the 5-cap is a HARD invariant (iterationCap>5 is INVALID); valid spec ->
//     ok with defaults filled (absent budgets -> defaults; absent smoke ->
//     {cmd:null,expect:null}).
// ---------------------------------------------------------------------------

let mod = /** @type {any} */ (null);
let importError = /** @type {any} */ (null);
try {
  mod = await import('../../core/src/loop/spec.mjs');
} catch (e) {
  importError = e;
}
/** Meaningful red until the module exists. */
function M() {
  assert.ok(mod, `core/src/loop/spec.mjs must load (import error: ${importError?.message ?? 'none'})`);
  return mod;
}

// The default-spec role sequence, fully specified by the plan.
const ROLE_SEQUENCE = [
  'planner',
  'plan-reviewer',
  'test-author',
  'test-verifier',
  'implementer',
  'test-author',
  'test-verifier',
  'implementer',
  'subtask-reviewer',
  'final-reviewer-a',
  'final-reviewer-b',
];

// A config carrying every role the default spec references (the real matrix ids).
function fullConfig() {
  return {
    schema: 'baton/config@1',
    roles: {
      planner: ['claude-code/claude-fable-5'],
      'plan-reviewer': ['codex/gpt-5.6-sol@xhigh'],
      'test-author': ['claude-code/claude-opus-4-8'],
      'test-verifier': ['codex/gpt-5.5@xhigh'],
      implementer: ['claude-code/claude-fable-5'],
      'subtask-reviewer': ['codex/gpt-5.6-sol@xhigh'],
      'final-reviewer-a': ['codex/gpt-5.6-sol@xhigh'],
      'final-reviewer-b': ['claude-code/claude-fable-5@xhigh'],
    },
    platforms: { 'claude-code': {}, codex: {}, cursor: {} },
    defaults: { 'claude-code': 'claude-fable-5', codex: 'gpt-5.6-sol', cursor: 'composer' },
  };
}

/** A minimal, otherwise-valid spec used as the base for single-defect cases. */
function validSpec(over = {}) {
  return {
    schema: 'baton/loop@1',
    goal: 'Ship the widget',
    constraints: [],
    smoke: { cmd: null, expect: null },
    phases: [
      { id: 'plan', role: 'planner' },
      { id: 'gate-1', role: 'plan-reviewer' },
    ],
    budgets: { iterationCap: 5, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 },
    ...over,
  };
}

// ===========================================================================
describe('defaultLoopSpec(goal) — scaffold shape', () => {
  it('carries schema, goal, constraints, smoke, budgets', () => {
    const { defaultLoopSpec } = M();
    const s = defaultLoopSpec('Ship X');
    assert.equal(s.schema, 'baton/loop@1');
    assert.equal(s.goal, 'Ship X', 'the goal is echoed verbatim');
    assert.deepEqual(s.constraints, []);
    assert.deepEqual(s.smoke, { cmd: null, expect: null });
    assert.deepEqual(s.budgets, { iterationCap: 5, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 });
  });

  it('phases are the exact default role sequence, in order', () => {
    const { defaultLoopSpec } = M();
    const s = defaultLoopSpec('g');
    assert.ok(Array.isArray(s.phases), 'phases is an array');
    assert.deepEqual(s.phases.map((/** @type {any} */ p) => p.role), ROLE_SEQUENCE, 'the default role chain matches the plan');
  });

  it('the explicitly-named phase ids are pinned; every phase id is a non-empty string', () => {
    const { defaultLoopSpec } = M();
    const s = defaultLoopSpec('g');
    const byIndex = s.phases;
    assert.equal(byIndex[0].id, 'plan');
    assert.equal(byIndex[1].id, 'gate-1');
    assert.equal(byIndex[2].id, 'smoke-tests');
    assert.equal(byIndex[3].id, 'smoke-verify');
    assert.equal(byIndex[4].id, 'smoke-build');
    // gate-2 appears twice at the tail.
    assert.match(byIndex[9].id, /gate-2/, 'first gate-2 phase id');
    assert.match(byIndex[10].id, /gate-2/, 'second gate-2 phase id');
    for (const p of s.phases) {
      assert.ok(typeof p.id === 'string' && p.id.length > 0, `phase id must be a non-empty string (role ${p.role})`);
      assert.ok(typeof p.role === 'string' && p.role.length > 0);
    }
  });

  it("the default spec validates against a matrix carrying all its roles", () => {
    const { defaultLoopSpec, validateLoopSpec } = M();
    const r = validateLoopSpec(defaultLoopSpec('g'), fullConfig());
    assert.equal(r.ok, true, `the shipped default must be self-consistent; errors: ${JSON.stringify(r.errors)}`);
  });
});

// ===========================================================================
describe('validateLoopSpec — accepts a valid spec and fills defaults', () => {
  it('a valid spec returns {ok:true, spec}', () => {
    const { validateLoopSpec } = M();
    const r = validateLoopSpec(validSpec(), fullConfig());
    assert.equal(r.ok, true);
    assert.ok(r.spec, 'the normalized spec is returned');
  });

  it('absent budgets are filled with the defaults — while the untouched fields survive', () => {
    const { validateLoopSpec } = M();
    const spec = validSpec();
    delete spec.budgets;
    const r = validateLoopSpec(spec, fullConfig());
    assert.equal(r.ok, true);
    assert.deepEqual(r.spec.budgets, { iterationCap: 5, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 });
    // Only the ABSENT field is filled; caller-supplied fields are preserved.
    assert.equal(r.spec.goal, spec.goal, 'the goal survives');
    assert.deepEqual(r.spec.phases, spec.phases, 'the phases (and their ids) survive');
    assert.deepEqual(r.spec.smoke, spec.smoke, 'the caller smoke survives');
  });

  it('absent smoke is filled with {cmd:null, expect:null} — while the untouched fields survive', () => {
    const { validateLoopSpec } = M();
    const spec = validSpec();
    delete spec.smoke;
    const r = validateLoopSpec(spec, fullConfig());
    assert.equal(r.ok, true);
    assert.deepEqual(r.spec.smoke, { cmd: null, expect: null });
    assert.equal(r.spec.goal, spec.goal, 'the goal survives');
    assert.deepEqual(r.spec.phases, spec.phases, 'the phases (and their ids) survive');
    assert.deepEqual(r.spec.budgets, spec.budgets, 'the caller budgets survive');
  });

  it('PRESERVES a valid CUSTOM spec ENTIRELY — every present field verbatim, only ABSENT defaults filled', () => {
    const { validateLoopSpec } = M();
    const custom = {
      schema: 'baton/loop@1',
      goal: 'Custom goal',
      constraints: ['no-network', 'deterministic-only'],
      smoke: { cmd: 'npm test', expect: 'all green' },
      phases: [
        { id: 'design', role: 'planner' },
        { id: 'review', role: 'plan-reviewer' },
        { id: 'build', role: 'implementer' },
      ],
      budgets: { iterationCap: 3, perRoleTimeoutMin: 15, maxChildrenPerPhase: 4 },
    };
    const r = validateLoopSpec(custom, fullConfig());
    assert.equal(r.ok, true, `a valid custom spec must pass; errors: ${JSON.stringify(r.errors)}`);
    // Every field of a fully-specified valid spec survives verbatim — including
    // phase IDS (design/review/build), which a default-substituting impl would lose.
    assert.deepEqual(r.spec, custom, 'a fully-specified valid spec is returned byte-for-byte (no default substitution)');
  });
});

// ===========================================================================
describe('validateLoopSpec — rejections (each error names the offender)', () => {
  const bad = (over, needle) => {
    const { validateLoopSpec } = M();
    const r = validateLoopSpec(validSpec(over), fullConfig());
    assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(over)}`);
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0, 'errors is a non-empty array');
    assert.ok(r.errors.some((/** @type {string} */ e) => new RegExp(needle).test(e)), `an error mentions ${needle}; got ${JSON.stringify(r.errors)}`);
  };

  it('wrong schema', () => bad({ schema: 'baton/loop@2' }, 'schema'));
  it('missing schema', () => bad({ schema: undefined }, 'schema'));
  it('missing goal', () => bad({ goal: undefined }, 'goal'));
  it('empty goal', () => bad({ goal: '' }, 'goal'));
  it('phases not an array', () => bad({ phases: 'nope' }, 'phases'));
  it('phases empty', () => bad({ phases: [] }, 'phases'));
  it('a phase missing id', () => bad({ phases: [{ role: 'planner' }] }, 'id'));
  it('a phase missing role', () => bad({ phases: [{ id: 'x' }] }, 'role'));

  it("a phase role not in config.roles reports \"unknown role '<id>'\"", () => {
    const { validateLoopSpec } = M();
    const r = validateLoopSpec(validSpec({ phases: [{ id: 'plan', role: 'planner' }, { id: 'x', role: 'ghost-role' }] }), fullConfig());
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((/** @type {string} */ e) => e.includes("unknown role 'ghost-role'")), `got ${JSON.stringify(r.errors)}`);
  });

  it("the unknown-role check fires against a config MISSING a referenced role", () => {
    const { defaultLoopSpec, validateLoopSpec } = M();
    const cfg = fullConfig();
    delete cfg.roles['subtask-reviewer']; // the default spec references it
    const r = validateLoopSpec(defaultLoopSpec('g'), cfg);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((/** @type {string} */ e) => e.includes("unknown role 'subtask-reviewer'")), `got ${JSON.stringify(r.errors)}`);
  });

  it('budgets.iterationCap missing (budgets present, cap absent)', () => bad({ budgets: { perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 } }, 'iterationCap'));
  it('budgets.iterationCap non-number', () => bad({ budgets: { iterationCap: 'five', perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 } }, 'iterationCap'));
  it('budgets.iterationCap < 1', () => bad({ budgets: { iterationCap: 0, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 } }, 'iterationCap'));

  it('budgets.iterationCap > 5 is INVALID — the 5-cap is a hard invariant', () => {
    const { validateLoopSpec } = M();
    const r = validateLoopSpec(validSpec({ budgets: { iterationCap: 6, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 } }), fullConfig());
    assert.equal(r.ok, false, 'a spec asking for a 6th iteration must be rejected');
    assert.ok(r.errors.some((/** @type {string} */ e) => /iterationCap/.test(e)), `got ${JSON.stringify(r.errors)}`);
  });

  it('budgets.perRoleTimeoutMin missing', () => bad({ budgets: { iterationCap: 5, maxChildrenPerPhase: 10 } }, 'perRoleTimeoutMin'));
  it('budgets.perRoleTimeoutMin non-number', () => bad({ budgets: { iterationCap: 5, perRoleTimeoutMin: 'lots', maxChildrenPerPhase: 10 } }, 'perRoleTimeoutMin'));
  it('budgets.perRoleTimeoutMin non-positive', () => bad({ budgets: { iterationCap: 5, perRoleTimeoutMin: 0, maxChildrenPerPhase: 10 } }, 'perRoleTimeoutMin'));
  it('budgets.maxChildrenPerPhase missing', () => bad({ budgets: { iterationCap: 5, perRoleTimeoutMin: 30 } }, 'maxChildrenPerPhase'));
  it('budgets.maxChildrenPerPhase non-number', () => bad({ budgets: { iterationCap: 5, perRoleTimeoutMin: 30, maxChildrenPerPhase: 'many' } }, 'maxChildrenPerPhase'));
  it('budgets.maxChildrenPerPhase non-positive', () => bad({ budgets: { iterationCap: 5, perRoleTimeoutMin: 30, maxChildrenPerPhase: 0 } }, 'maxChildrenPerPhase'));

  it('constraints not an array', () => bad({ constraints: 'no-network' }, 'constraints'));
  it('constraints with a non-string entry', () => bad({ constraints: ['ok', 123] }, 'constraints'));

  it('smoke present but cmd not string-or-null', () => bad({ smoke: { cmd: 123, expect: null } }, 'cmd|smoke'));
  it('smoke present but expect not string-or-null', () => bad({ smoke: { cmd: null, expect: 7 } }, 'expect|smoke'));

  it('reports ALL problems at once, not just the first', () => {
    const { validateLoopSpec } = M();
    const r = validateLoopSpec(
      validSpec({ schema: 'wrong', goal: '', budgets: { iterationCap: 6, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 } }),
      fullConfig(),
    );
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((/** @type {string} */ e) => /schema/.test(e)), 'schema error present');
    assert.ok(r.errors.some((/** @type {string} */ e) => /goal/.test(e)), 'goal error present');
    assert.ok(r.errors.some((/** @type {string} */ e) => /iterationCap/.test(e)), 'iterationCap error present');
    assert.ok(r.errors.length >= 3, `all three problems reported; got ${JSON.stringify(r.errors)}`);
  });

  it('aggregates EVERY offender across a spec riddled with defects', () => {
    const { validateLoopSpec } = M();
    const r = validateLoopSpec(
      {
        schema: 'baton/loop@9', // bad schema
        goal: '', // empty goal
        constraints: 'nope', // not an array
        phases: [
          { role: 'planner' }, // missing id
          { id: 'x', role: 'ghost-role' }, // unknown role
        ],
        smoke: { cmd: 123, expect: null }, // bad smoke.cmd
        budgets: { iterationCap: 6, perRoleTimeoutMin: 0, maxChildrenPerPhase: 'x' }, // three bad budget fields
      },
      fullConfig(),
    );
    assert.equal(r.ok, false);
    const joined = r.errors.join(' | ');
    for (const needle of [/schema/, /goal/, /constraints/, /\bid\b/, /unknown role 'ghost-role'/, /cmd|smoke/, /iterationCap/, /perRoleTimeoutMin/, /maxChildrenPerPhase/]) {
      assert.ok(needle.test(joined), `an error mentions ${needle}; got ${JSON.stringify(r.errors)}`);
    }
  });
});
