<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, auditing the ACCEPTANCE-phase tests for subtask `e2e-acceptance` — real-fs/real-git integration proofs of the milestone-B acceptance constraints. Uncommitted new file: tests/integration/loop-pipeline-e2e.test.mjs (7 tests: 5 GREEN acceptance pins, 2 RED implementation-gap findings); suite 1138 with 1131 pre-existing green; typecheck green.

The claimed findings the reds encode (plan §Acceptance constraints 2 and 5):
(1) teardownWorktrees deletes only each worktree's currently-checked-out branch, orphaning baton/wt-*/base after seats moved to subtask branches — residue violating constraint 5;
(2) runLoop accumulates `avoid` across failovers so a chained A→B→A death parks with everything avoided instead of returning to A — violating constraint 2 (the failover avoid must be per-death, not cumulative).

Audit:
1. Are the two REDS testing the REQUIREMENT (not an arbitrary implementation preference)? Cross-check constraint 2 ("Chained A→B→A tested") and constraint 5 ("leaves the fixture repo exactly as a plain git repo") in docs/plans/2026-07-18-goal-loop-worktree-pipeline.md, and the cited implementation sites (core/src/commands/loop.mjs avoid accumulation; core/src/loop/worktrees.mjs teardown branch selection).
2. Are the 5 GREENS meaningful acceptance pins (not tautologies)? Especially: does the pipeline e2e prove REAL merges landed with sole-author identity via real git (not just exit codes)? Does the limit-death test inspect the real .handoff artifacts? Does no-residue genuinely diff the tree?
3. Integration robustness: real-git usage, win32 skip, temp-dir hygiene, bounded timings, realpath canonicalization — any flakiness risk?
4. Would a WRONG fix pass? E.g. a teardown that deletes ALL branches (including user branches) would fix the residue red — does a green pin protect non-baton branches at teardown here or in the unit suite? A chained-failover fix that never avoids anything could thrash A→A — does the suite (unit or e2e) still pin that the immediate dead platform is avoided per hop?

You may run: node --test tests/integration/loop-pipeline-e2e.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts (ran/read) from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
