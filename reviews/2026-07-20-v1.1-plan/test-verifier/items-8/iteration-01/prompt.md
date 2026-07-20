<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, items-8 series iteration 1 of 5, auditing the Milestone-D build pins for plan item 8 (probe integration) BEFORE implementation. Authority: docs/plans/2026-07-20-v1.1-hardening.md item 8. Baseline HEAD (items 1-7 landed; suite 1237 green). Uncommitted, tests-only: tests/commands/loop-run.test.mjs + tests/commands/pipeline-run.test.mjs. Claimed totals: suite 1243, 1239 pass / 4 red (8-1, 8-2, 8-2-failover, 8-3), guards 8-4/8-5 green, typecheck green. NOTE: your sandbox cannot mkdtemp — the command suites run for you.

The pins:
- 8-1 (RED, loop): a fresh .handoff/log/probe-cache.json rate-limiting the implementer chain head (claude-code) diverts the first spawn to the codex fallback (command codex / gpt-5.6-sol). Today probes: null → claude-code spawns.
- 8-2 (RED, pipeline first writer): fresh cache rate-limiting worker-a's head diverts the first writer to cx-wa.
- 8-2-failover (RED): worker-a [codex head → claude-code middle (rate-limited) → cursor tail]; codex head dies model-unavailable; the failover relaunch skips the rate-limited middle and lands on cu-tail (proving runFailover receives the cache).
- 8-3 (RED, pipeline reviewer): rate-limiting worker-b's head diverts the reviewer to cx-rev (superviseVerdictChild/resolveOne path).
- GUARD 8-4 (green): stale cache (20 min, past 15-min window) AND missing cache both change nothing.
- GUARD 8-5 (green): a fresh cache marking the head merely unverifiable (installed/ok, not rate-limited) still resolves it.
Note: children identified by prompt role phrase, not the -s flag (claude-code children carry no -s).

Audit adversarially:
1. Would a WRONG implementation pass? (a) is the seeded cache genuinely FRESH per readProbeCache's actual freshness rule (check core/src/roles/availability.mjs for the timestamp field + window — 8-4's stale fixture must be just past it, not wildly off)? (b) does 8-2-failover prove the cache reaches runFailover specifically (the middle is skipped for RATE-LIMIT, not merely because it was the just-died platform)? (c) do the reds assert the fallback SPAWNED (recorded argv) rather than just "head absent"? (d) 8-5 — is 'unverifiable' the real cache vocabulary from availability.mjs, not an invented status?
2. Red-phase integrity: 4 reds behavioral (no ReferenceError/TypeError), guards meaningful, baseline 1237 unaffected.
3. Coverage vs plan item 8: any acceptance sub-item unpinned (first spawn + all failover relaunches in BOTH commands; offline-degraded preserved)?

You may run: node --test tests/commands/loop-run.test.mjs tests/commands/pipeline-run.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
