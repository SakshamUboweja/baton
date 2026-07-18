/**
 * Loop spec (baton/loop@1) — pure load/validate for the Layer-2 goal loop.
 * The spec is committed project config (loop.json at the repo root); run
 * state lives elsewhere (.handoff/loop/). Plan:
 * docs/plans/2026-07-18-goal-loop-worktree-pipeline.md §"Loop spec".
 */

export const LOOP_SCHEMA = 'baton/loop@1';

// The 5-cap is a repo-wide hard invariant (AGENTS.md §Review gates): a spec
// asking for a 6th gate iteration is invalid, not a preference.
export const ITERATION_CAP_MAX = 5;

const DEFAULT_BUDGETS = Object.freeze({ iterationCap: 5, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 });

/**
 * The scaffold `baton loop init` writes. Phase ids are progress labels;
 * every role is a matrix role ID resolved via baton.config.json — never a
 * model name.
 * @param {string} goal
 * @returns {any}
 */
export function defaultLoopSpec(goal) {
  return {
    schema: LOOP_SCHEMA,
    goal,
    constraints: [],
    smoke: { cmd: null, expect: null },
    phases: [
      { id: 'plan', role: 'planner' },
      { id: 'gate-1', role: 'plan-reviewer' },
      // The smoke slice is itself a TDD mini-cycle (Gate-1 iter-2 finding 2):
      // failing smoke assertion → verifier approval → minimal implementation.
      { id: 'smoke-tests', role: 'test-author' },
      { id: 'smoke-verify', role: 'test-verifier' },
      { id: 'smoke-build', role: 'implementer' },
      { id: 'subtask-tests', role: 'test-author' },
      { id: 'subtask-verify', role: 'test-verifier' },
      { id: 'subtask-implement', role: 'implementer' },
      { id: 'subtask-review', role: 'subtask-reviewer' },
      { id: 'gate-2-a', role: 'final-reviewer-a' },
      { id: 'gate-2-b', role: 'final-reviewer-b' },
    ],
    budgets: { ...DEFAULT_BUDGETS },
  };
}

/**
 * Validate a loop spec against the role matrix. Reports EVERY problem at
 * once (each error names its offender) so a spec author fixes one round, not
 * one field per run. Valid specs are returned normalized: caller-provided
 * fields are preserved verbatim; only ABSENT constraints/budgets/smoke are
 * filled with defaults.
 * @param {any} spec
 * @param {any} config the parsed baton.config.json (roles are checked against it)
 * @returns {{ok: true, spec: any} | {ok: false, errors: string[]}}
 */
export function validateLoopSpec(spec, config) {
  /** @type {string[]} */
  const errors = [];
  const s = spec ?? {};

  if (s.schema !== LOOP_SCHEMA) errors.push(`schema must be '${LOOP_SCHEMA}' (got ${JSON.stringify(s.schema)})`);
  if (typeof s.goal !== 'string' || s.goal.length === 0) errors.push('goal must be a non-empty string');

  let constraints = s.constraints;
  if (constraints === undefined) constraints = [];
  if (!Array.isArray(constraints)) {
    errors.push('constraints must be an array of strings');
  } else {
    constraints.forEach((c, i) => {
      if (typeof c !== 'string') errors.push(`constraints[${i}] must be a string (got ${JSON.stringify(c)})`);
    });
  }

  const roles = config?.roles ?? {};
  if (!Array.isArray(s.phases) || s.phases.length === 0) {
    errors.push('phases must be a non-empty array of {id, role}');
  } else {
    s.phases.forEach((/** @type {any} */ p, /** @type {number} */ i) => {
      if (typeof p?.id !== 'string' || p.id.length === 0) errors.push(`phases[${i}] is missing an id (a non-empty progress label)`);
      if (typeof p?.role !== 'string' || p.role.length === 0) {
        errors.push(`phases[${i}] is missing a role (a baton.config.json role ID)`);
      } else if (!(p.role in roles)) {
        errors.push(`phases[${i}]: unknown role '${p.role}' — add it to baton.config.json roles or fix the reference`);
      }
    });
  }

  let budgets = s.budgets;
  if (budgets === undefined) {
    budgets = { ...DEFAULT_BUDGETS };
  } else if (typeof budgets !== 'object' || budgets === null) {
    errors.push('budgets must be an object');
  } else {
    const cap = budgets.iterationCap;
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 1 || cap > ITERATION_CAP_MAX) {
      errors.push(`budgets.iterationCap must be a number between 1 and ${ITERATION_CAP_MAX} (the 5-iteration cap is a hard invariant; got ${JSON.stringify(cap)})`);
    }
    for (const field of ['perRoleTimeoutMin', 'maxChildrenPerPhase']) {
      const v = budgets[field];
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        errors.push(`budgets.${field} must be a positive number (got ${JSON.stringify(v)})`);
      }
    }
  }

  let smoke = s.smoke;
  if (smoke === undefined) {
    smoke = { cmd: null, expect: null };
  } else if (typeof smoke !== 'object' || smoke === null) {
    errors.push('smoke must be an object ({cmd, expect}, each a string or null)');
  } else {
    if (!(smoke.cmd === null || typeof smoke.cmd === 'string')) errors.push(`smoke.cmd must be a string or null (got ${JSON.stringify(smoke.cmd)})`);
    if (!(smoke.expect === null || typeof smoke.expect === 'string')) errors.push(`smoke.expect must be a string or null (got ${JSON.stringify(smoke.expect)})`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, spec: { ...s, constraints, budgets, smoke } };
}
