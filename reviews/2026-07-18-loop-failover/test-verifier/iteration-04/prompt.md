<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, iteration 4 of 5, for subtask `loop-failover`. You APPROVED the red tests at iteration 3. Since then the implementation (core/src/loop/failover.mjs) landed and exposed a crash in the tests' OWN scaffolding: the historyFreezes helper JSON.parsed every file in the bundle history dir, but rotateJournalIn (core/src/bundle/store.mjs:264) legitimately writes .ndjson journal files there that can be empty or multi-line NDJSON. Per the repo TDD contract, this test modification re-enters your review.

The single change (uncommitted alongside the implementation): historyFreezes now filters to names ending in .json (excluding .ndjson) before parsing. The author asserts no assertion changed — all assertions target .finalize.json / received .json freezes. All 17 tests now pass against the implementation; the full suite is 1064/1064 green.

Scope: read the helper diff area (tests/unit/loop-failover.test.mjs, historyFreezes) and confirm (1) the filter cannot hide a defect the assertions relied on (e.g. could an assertion that counts historyFreezes().length === 0 be weakened by excluding .ndjson? check every call site); (2) no other test logic changed; (3) the now-green tests still constitute the approved contract (spot-check that the implementation isn't gaming any pin — e.g. read core/src/loop/failover.mjs against the checkpoint-before-seal and window-count pins). Raise only real defects.

You may run: node --test tests/unit/loop-failover.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts (ran/read) from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
