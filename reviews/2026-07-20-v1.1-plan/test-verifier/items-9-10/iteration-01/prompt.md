<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, items-9-10 series iteration 1 of 5, auditing the FINAL Milestone-D feature pins for plan items 9 (pipeline smoke gate) and 10 (--detach) BEFORE implementation. Authority: docs/plans/2026-07-20-v1.1-hardening.md items 9-10. Baseline 0213eeb (items 1-8 landed; suite 1248 green). Uncommitted, tests-only: tests/commands/pipeline-run.test.mjs (item 9 + 10-pipeline), tests/commands/loop-run.test.mjs (10-loop). Claimed totals: suite 1259, 1251 pass / 8 red, 3 guards green, typecheck green. NOTE: your sandbox cannot mkdtemp — the command suites run for you (memfs + injected seam, no real fork).

The pins:
- 9-1 (RED): pipeline with smoke.cmd awaits approval after the LAST subtask merges (status awaiting-smoke-approval, SMOKE-REVIEW.md + smoke-approval.json smk1. drift-bound token, exit 0), not straight to DONE.
- 9-2 (RED): pipeline run --approve-smoke <token> verifies + completes (raw state.json done).
- 9-3 (RED): a drifted token (main moved) is refused → PARK exit 4.
- GUARD 9-4 (green): no smoke.cmd → straight to DONE.
- GUARD 9-5 (green): a pipeline spec with smoke.cmd and NO phases is accepted (loop's smoke-build validation never gates pipelines).
- 10-1 loop + 10-1 pipeline (RED): --detach forks via io.spawnDetached seam; parent exits 0; the run lock names the detached pid; stdout prints pid + supervisor.out tail hint.
- 10-2 (RED): --detach with a live lock refuses exit 1, no fork.
- 10-3 (RED): --detach with a dead lock + recorded in-flight children reclaims (kills child pgids) before forking.
- GUARD 10-4 (green): a completing run releases the lock (the reused release contract).
- 10-5 (RED): --detach directs output to a byte-capped .handoff/loop/supervisor.out (seam gets outPath + positive cap).

FOUR SEAM JUDGMENT CALLS to rule on explicitly (the test-author flagged these; documented in test comments):
1. Item 10 pins through a DEFINED injected seam io.spawnDetached(spec) -> {pid} (default: real detached spawn) instead of a real fork. Is the seam name/shape (incl. outPath + cap field) sound and honest, or does it over-fit a specific implementation?
2. The pins assume the PARENT checks the lock (refuse-live/reclaim-dead) BEFORE forking and the DETACHED CHILD owns the lock (named by its pid). Is that the right contract?
3. 10-4 (lock release on detached completion) pinned on the ATTACHED path (isolating the detached child's release needs a real child). Acceptable, or must there be a detached-completion release pin?
4. Item 10 placed in the command test files (memfs + seam), not a real-fork integration file. Acceptable?

Audit adversarially: would a wrong impl pass 9-1/9-2/9-3 (token genuinely drift-bound + verified, not just any string)? Does 10-2 assert NO fork (seam not called) on the live-lock refusal? Does 10-3 assert the child pgids were killed before the fork? Red-phase integrity, guards meaningful, baseline 1248 unaffected. Coverage vs plan items 9-10: anything unpinned.

You may run: node --test tests/commands/loop-run.test.mjs tests/commands/pipeline-run.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
