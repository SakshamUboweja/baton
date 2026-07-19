<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, i-series iteration 4 of 5, auditing the FINAL Gate-2 fold pins BEFORE implementation: findings J1–J2 per the "Iteration 4" section of reviews/2026-07-19-gate-2-milestone-b/findings.md (read it first; reviewer-a APPROVED at Gate-2 iteration 4, reviewer-b BLOCKED with these two). Uncommitted: changes to tests/commands/pipeline-run.test.mjs only. Claimed totals: 4 new tests + 1 modified in place; suite 1187 with 1183 pass / 4 red; typecheck green. NOTE: your sandbox cannot mkdtemp — integration files are environment noise; judge by reading.

The pins:
- J1a (RED): a PARKED pipeline state + `baton pipeline resume` → the run transitions RESUME and continues: the parked subtask t1's writer re-spawns in WT_A (not skipped), and a seeded nonzero gate counter (subtask-t1-review: 3) SURVIVES resume — no cap refund. Today `resume` is an unknown subcommand (exit 2, zero spawns).
- J1b (RED): `pipeline resume` on an ESCALATED state → exit 3, operator-only, zero spawns, stays escalated.
- J1c (RED): `pipeline resume` on a loop-flavored state → exit 2 naming the flavor mismatch, zero spawns.
- J1d (GREEN companion): `baton loop resume` still refuses a pipeline-flavored state — the flavor boundary holds in both directions.
- J2 (in-place on the existing I1a test, flipped green→red): the ancestor-without-receipt stale park keeps exit 4 + /stale/i + zero merges, and now must also hedge both causes (/crashed before committing|merged without a receipt|not.*recorded/i), point the operator at `git log main..<branch>`, and mention the seat/worktree checkout in the remediation.

Audit adversarially:
1. Would a WRONG implementation pass? (a) J1a — is the no-cap-refund pinned by seeding a NONZERO counter and asserting it survives (a re-init implementation must fail), and does the writer-respawn assertion prove the SAME subtask re-runs rather than the run merely exiting 0? (b) J1b/J1c — refusals pinned pre-spawn with the right exit codes (3 vs 2)? (c) J2 — do the added message assertions coexist with the original I1a assertions without weakening any (exit 4, /stale/i, zero merges all still asserted)?
2. Red-phase integrity: the 4 reds fail today on behavioral assertions (no ReferenceError/TypeError); J1d green is meaningful; no regressions beyond the intentional I1a flip.
3. Coverage vs J1–J2: any sub-item unpinned (e.g. resume on a RUNNING state — is unparked resume a no-op/continue, and does any pin over-constrain that)?

This is the final fold before reviewer-b's FINAL iteration-5 re-review — distinguish anything genuinely blocking from refinements the implementation can absorb.

You may run: node --test tests/commands/pipeline-run.test.mjs tests/commands/loop-run.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
