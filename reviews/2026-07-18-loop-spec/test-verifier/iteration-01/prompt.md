<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, auditing RED-phase tests for subtask `loop-spec` BEFORE implementation. Uncommitted new files: tests/unit/loop-spec.test.mjs (24 tests) and tests/commands/loop-init.test.mjs (12 tests); all 36 red on meaningful assertions (dynamic-import-with-catch), 942 pre-existing green, typecheck green.

Contract (plan: docs/plans/2026-07-18-goal-loop-worktree-pipeline.md, sections "Loop spec", "Role-matrix additions", "baton loop" — read them): core/src/loop/spec.mjs exports defaultLoopSpec(goal) (schema baton/loop@1, {id, role} phases with the pinned role sequence, budgets {iterationCap:5, perRoleTimeoutMin:30, maxChildrenPerPhase:10}, smoke {cmd:null, expect:null}) and validateLoopSpec(spec, config) → {ok:true, spec}|{ok:false, errors[]} with every rejection naming its offender, "unknown role '<id>'" for roles absent from config.roles, iterationCap > 5 INVALID (hard invariant), ALL problems reported at once, defaults filled for absent budgets/smoke. `baton loop init "<goal>"` routes through cli.mjs: no-sub/unknown-sub/no-goal usage errors exit 2; writes loop.json === defaultLoopSpec(goal) at the resolved root (--root honored); --json envelope data {created, path}; --dry-run writes nothing; existing loop.json never overwritten (created:false, bytes untouched); strict flags; BATON_SUPERVISED_CHILD does NOT suppress loop commands (supervisor-side).

Audit adversarially:
1. Would these pass against a WRONG implementation? (e.g. validateLoopSpec returning first-error-only; unknown-role check reading the DEFAULT config rather than the passed one; iterationCap 6 accepted; loop init overwriting an existing file; dry-run writing then deleting; created:true on the idempotent path; phases validated for shape but roles never cross-checked; goal ending up interpolated but not the byte-equality with defaultLoopSpec.) Name holes.
2. API sanity for downstream consumers (loop-state subtask 6, loop-run subtask 9): is anything pinned that will hamstring them, or left so loose a degenerate implementation passes? Flag over-pinning AND under-pinning.
3. Red-phase integrity: each red fails on a meaningful assertion (not a file-level crash); the cli routing reds genuinely distinguish "loop unknown" today from the target behaviors.
4. Idiom conformance: makeIo/memfs usage, strict-flag table conventions, envelope assertions match the repo's real shapes (cross-check core/src/cli.mjs run() dispatch, shared.mjs usageError, an existing command test).

You may run: node --test tests/unit/loop-spec.test.mjs tests/commands/loop-init.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts (ran/read) from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
