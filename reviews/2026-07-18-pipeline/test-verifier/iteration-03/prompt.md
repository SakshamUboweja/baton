<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, iteration 3 of 5, for subtask `pipeline` red-phase tests. Iteration 2 raised exactly ONE high finding: no proof that pipeline run composes the worktree preflight/postflight guards. Prior reports: reviews/2026-07-18-pipeline/test-verifier/iteration-0{1,2}/raw-output.txt.

Claimed fix (uncommitted; tests/commands/pipeline-run.test.mjs now 20 tests: 19 red, 1 green; 1111 pre-existing green; typecheck green): a "worktree guard composition" describe — (a) dirty writer seat → preflight refusal before ANY spawn (zero children, no merge, exit 4, PARKED persisted); (b) wrong-branch seat → same shape; (c) postflight drift via a new fake-runner per-result `effect` hook that moves the stateful git's main between spawn and postflight → parked exit 4, exactly one child (the writer), no reviewer/merger, no merge git. Supporting changes: pipelineGit.moveMain(sha) + the effect callback.

Scope: verify the closure is genuine (read the new tests + the effect-hook mechanics — does the postflight-drift case genuinely exercise the real postflightWorktree main-moved path given how the stateful fake answers rev-parse main?), confirm red-phase integrity and no regressions, raise only NEW defects. Do not re-raise closed findings unless a closure is defective.

You may run: node --test tests/commands/pipeline-run.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts (ran/read) from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
