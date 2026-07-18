<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh; no fallback needed for this role.
You are the test-verifier for the baton repo, auditing the RED-phase tests for subtask `l1-supervised-guard` BEFORE any implementation exists. The working tree contains the uncommitted tests: tests/unit/supervised-child-guard.test.mjs (new, 11 tests) and a new describe block appended to tests/adapters/claude-code-hook-script.test.mjs (4 tests).

Contract under test (docs/plans/2026-07-18-goal-loop-worktree-pipeline.md, "Child-hook policy" — Gate-1 iteration-2 finding 1 + iteration-3 finding 1): when env BATON_SUPERVISED_CHILD is set to any non-empty value, cmdCheckpoint, cmdSessionStart, and the Claude Code hook script must silently no-op — exit 0, empty stdout AND stderr (even with --json), zero reads of any path under .handoff/, zero writes anywhere, and the hook script must not spawn any baton child. Unset or empty-string env = normal behavior. The test-author additionally pinned guard-before-parsing (garbled invocations also silent no-op) — judge whether that pin is sound for a supervisor-spawned hook context.

Audit adversarially:
1. Would these tests pass against a WRONG implementation? (e.g. guard that suppresses output but still reads the bundle; guard that checks === '1' only; guard placed after flag parsing; hook that spawns but swallows the child.) Name any hole.
2. Are the spies real? Verify the no-read/no-write assertions actually intercept the fake-fs methods the commands use (cross-check tests/helpers/fakeio.mjs and the F12 read-spy precedent in tests/commands/gate2-iter3-group6.test.mjs).
3. Do the negatives (unset/empty-string) genuinely exercise the normal path (i.e., would they fail if the guard over-triggered)?
4. Red-phase integrity: confirm each new test fails against CURRENT code for the RIGHT reason (the asserted behavior is absent), not due to setup bugs. Existing tests must be untouched/green.
5. Coverage gaps vs the plan contract: anything the acceptance constraint ("zero bundle writes AND zero session-start resume context on all three platforms") needs that these tests don't pin at the unit level?

You may run: node --test tests/unit/supervised-child-guard.test.mjs, node --test tests/adapters/claude-code-hook-script.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts (ran/read) from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
