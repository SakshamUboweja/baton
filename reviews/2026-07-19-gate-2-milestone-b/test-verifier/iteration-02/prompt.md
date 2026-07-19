<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, iteration 2 of 5, re-auditing the Gate-2 FOLD pins after your iteration-1 BLOCKED verdict (8 findings: ownedBundle ReferenceError; weak cap-refund; unseeded raw-deleted worktree; weak child-start record/ordering; kill-before-resume ordering; read-overfit B8; missing reviewer git-range prompt pin; fail-open claudeGrantsWrite). Your report: reviews/2026-07-19-gate-2-milestone-b/test-verifier/iteration-01/raw-output.txt.

Claimed fixes (uncommitted; 23 new tests, 21 red / 2 green; suite 1161 with 1138 pre-existing green; typecheck green; e2e 7/7): ownedBundle + CC_LIMIT added with failover-model + no-reviewer assertions; cap-refund uses a strict throwing runner + fresh git per run, run 1 crashes at exactly 3 persisted iterations, run 2 escalates at cumulative 5; pipelineGit.seedWorktree(path, branch, {raw}) + deletedCwds so the listed-but-missing seat rejects until prune, self-heal asserts prune + re-add; child-start pins the exact {childId, pid, pgid, startedAt} shape with an opts.onStart seam asserting the record exists in-flight; an interleaved events log asserts the orphan group (9001) is killed BEFORE the first new spawn; the B8 pin now runs over an O_EXCL-enforcing memfs wrapper (wx/ax → EEXIST) so exclusive acquisition passes and check-then-write fails; the reviewer prompt pin requires `git diff main..baton/wt-a/subtask-t1`; claudeGrantsWrite is fail-closed (only Read/Grep/Glob + scoped git-read Bash are read-only).

Scope: verify the 8 closures are genuine (read the tests; run the four suites), confirm no ReferenceErrors/TypeErrors among the reds, no pre-existing regression, and raise only NEW defects. Do not re-raise closed findings unless a closure is defective. NOTE: your sandbox cannot mkdtemp — integration files are environment noise.

You may run: node --test tests/unit/loop-spec.test.mjs tests/unit/loop-children.test.mjs tests/commands/loop-run.test.mjs tests/commands/pipeline-run.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
