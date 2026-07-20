<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, items-3-4 series iteration 1 of 5, auditing the Milestone-D build pins for plan items 3 (per-phase child budgets) and 4 (findings persistence) BEFORE implementation. Authority: docs/plans/2026-07-20-v1.1-hardening.md items 3–4 (Gate-1 approved). Baseline 6aced04 (items 1+2 landed; suite 1217 green). Uncommitted, tests-only: tests/commands/loop-run.test.mjs + tests/commands/pipeline-run.test.mjs. Claimed totals: suite 1225, 1218 pass / 7 red, guards green, typecheck green. NOTE: your sandbox cannot mkdtemp — integration files are environment noise; judge by reading.

The pins:
- ITEM 3 (RED): 3-phase spec, maxChildrenPerPhase 2, iterationCap 5, one gate always BLOCKED → parks (exit 4) NAMING that phase after its own 2-child budget, global product (6) untouched (today: runs to the 5-cap and escalates exit 3). GUARD green: three phases each spending 2 children (6 total) complete.
- SCOPING NOTE to judge: no pipeline twin — the pipeline has no maxChildrenPerPhase gate at all (its writer failover is chain-length-bounded), so a twin would invent a new per-subtask budget seam. Is loop-only acceptable against plan item 3's wording ("a phase exhausting its own budget parks naming the phase; other phases unaffected"), or is a pipeline pin required?
- ITEM 4 (six pins, both suites): 4a loop BLOCKED→park→resume, resumed child prompt embeds persisted findings from .handoff/loop/findings/<gate>.ndjson; 4b crash/re-invoke (seeded running state + iterations + seeded findings line) → FIRST child/writer prompt embeds it, both commands; 4c fresh-invoke cap escalation embeds persisted findings in ESCALATION.md with empty in-memory findings (pipeline currently falls to the D8 log-tail); 4d append-only two ordered lines. D8 byte-compat + empty-findings log-tail guards left intact (log-tail remains the fallback when persisted findings are also empty — the D8 fixture's reviewer blocks with EMPTY findings so no persisted content exists).

Audit adversarially:
1. Would a WRONG implementation pass? (a) item 3 — is the fixture's binding constraint genuinely the child budget (not iterationCap), and is the park reason asserted to NAME the exhausted phase? Could an impl park on the global product and still pass? (b) 4a/4b — are the prompts asserted to contain the DISTINCTIVE persisted findings text (not merely non-empty), and does 4b genuinely bypass in-memory state (fresh invocation)? (c) 4c — does it distinguish persisted-findings content from the log-tail fallback content? (d) 4d — order asserted?
2. Red-phase integrity: 7 reds behavioral (no ReferenceError/TypeError); guards meaningful; baseline 1217 unaffected.
3. Coverage vs plan items 3–4: any acceptance sub-item unpinned? Judge the pipeline-twin scoping question explicitly.

You may run: node --test tests/commands/loop-run.test.mjs tests/commands/pipeline-run.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
