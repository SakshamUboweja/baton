<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, items-8 series iteration 2 of 5, re-auditing item 8 (probe integration) after your iteration-1 BLOCKED verdict (2 coverage findings; report: reviews/2026-07-20-v1.1-plan/test-verifier/items-8/iteration-01/raw-output.txt). Uncommitted, tests-only; baseline HEAD (items 1-7 landed, suite 1237). The command suites run for you.

Claimed closures:
1. Every-failover coverage widened with cache-aware reds (dead head avoided AND rate-limited middle skipped to the surviving cursor tail, proving the fresh cache reached that runFailover): 8-1 failover (loop runFailover → cu-tail), 8-3 reviewer failover (pipeline superviseVerdictChild worker-b → cu-rvt), 8-3 merger failover (pipeline merger path → cu-mgt). Plus the existing 8-1/8-2/8-2-failover/8-3 first-spawn reds.
2. Pipeline guards added: 8-4 pipeline (stale AND missing cache → head spawns, unchanged), 8-5 pipeline (unverifiable-not-rate-limited head still resolves + writer.verdict.md keeps a non-empty degraded field).

Claimed totals: suite 1248, 1241 pass / 7 red, guards (loop+pipeline 8-4/8-5) green, typecheck green.

Scope: verify the widened coverage is genuine — each failover red proves the cache reached THAT runFailover (the middle is skipped for RATE-LIMIT specifically, not just because it was the just-died platform: confirm the head death and the middle rate-limit are independent so only cache-awareness lands the tail), guards meaningful, red-phase integrity, no weakening/regressions. Raise only NEW defects or defective closures — this is coverage completion, so confirm plan item 8's "every failover relaunch, both commands, writer/reviewer/merger" is now fully pinned.

You may run: node --test tests/commands/loop-run.test.mjs tests/commands/pipeline-run.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
