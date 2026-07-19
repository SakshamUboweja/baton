<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, iteration 3 of 5, for subtask `loop-failover` red-phase tests. Iteration 2 raised exactly ONE high finding: the open-bundle fixture demanded both a sealed .finalize.json freeze and a degradedSeal from the same shape — incompatible with the real finalize/receive semantics. Prior reports: reviews/2026-07-18-loop-failover/test-verifier/iteration-0{1,2}/raw-output.txt.

Claimed fix (uncommitted; tests/unit/loop-failover.test.mjs now 17 tests, all red via M(); 1047 pre-existing green; typecheck green): the scenario is split — (a) alive-supervisor open path (checkpoint → finalize → sealed receive; sealed freeze asserted, receive_log NOT degraded) and (b) a distinct degradedOpen:true input where runFailover skips finalize (NO .finalize.json freeze; receive_log flagged degradedSeal; generation bumps to 2). New optional API input `degradedOpen?` (default false).

Scope: verify the split is genuine and consistent with core/src/commands/finalize.mjs + core/src/receive/txn.mjs semantics (cite); judge whether `degradedOpen` as a caller-declared input is sound (the supervisor knows it could not seal — e.g. finalize itself died — versus the alternative of runFailover attempting finalize and tolerating failure; judge, and only block if the pinned expression would let a WRONG implementation pass); confirm red-phase integrity; raise only NEW defects.

You may run: node --test tests/unit/loop-failover.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts (ran/read) from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
