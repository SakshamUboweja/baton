<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, iteration 4 of 5 in the Gate-2 pin series, auditing the ITERATION-2 fold pins (H1–H8 per the "Iteration 2" section of reviews/2026-07-19-gate-2-milestone-b/findings.md) BEFORE implementation. Uncommitted: +6 tests in tests/commands/pipeline-run.test.mjs, +5 in tests/commands/loop-run.test.mjs, +2 in a new tests/unit/bin-io-shape.test.mjs. 13 new (12 red / 1 green); suite 1174 with 1161 pre-existing green; typecheck green. NOTE: your sandbox cannot mkdtemp — integration files are environment noise.

The pins:
- H1: the pipeline WRITER prompt carries the verdict-tail contract ("End with exactly" + "VERDICT:").
- H2a: an always-model-unavailable runner on a two-entry codex worker chain — relaunches never re-pick a rejected model (avoidEntries carry) and total rejection PARKS (bounded); H2b: an always-usage-limit runner also ends bounded (park), never an infinite loop.
- H3a: every children.ndjson start record gains a retire record {childId, endedAt} when the child resolves; H3b: dead-lock reclaim never kills a RETIRED child even when processAlive claims its (recycled) pgid is alive; the existing in-flight kill pin stays.
- H4: source-content pin on core/bin/baton.mjs — production io defines processAlive (green today) and process.kill-backed processKill (red).
- H5: state flavor binding — loop-flavor state refused by pipeline run and vice versa (exit 2 naming the mismatch); stale specDigest on resume refused. Stamp design: {flavor, specDigest = dedupeKey(subtasks|phases)}.
- H6: ESCALATION.md must not instruct 'baton loop run'; operator wording pinned.
- H7: fake git gains mergedBranches → merge-base --is-ancestor; an already-fully-merged subtask branch (empty main..branch log, is-ancestor true) ADVANCES on resume instead of the empty-branch park.
- H8: supervisor.lock runId equals state.runId by spawn time.

Audit adversarially:
1. Would a WRONG implementation pass? Probe: (a) H2a — is no-repeat asserted on the recorded --model args across ALL writer spawns, and is the park bounded by the runner (a throwing queue) rather than a large loop count?; (b) H3b — does the fixture make the retired child's pgid genuinely 'alive' via processAlive so only retire-awareness (not liveness) can prevent the kill?; (c) H5 — are refusals pinned BEFORE any spawn, and does the specDigest pin use a genuinely different subtasks list?; (d) H7 — could an implementation advance on ANY empty log (skipping the is-ancestor check) and still pass — is there a companion keeping the plain empty-branch park red-line intact?; (e) H4's source pin — precise enough (process.kill-backed) without over-fitting formatting?
2. Red-phase integrity (12 reds fail today for the right reasons — no ReferenceErrors), the 1 green meaningful, no pre-existing regressions.
3. Coverage vs H1–H8: any sub-item unpinned?

You may run: node --test tests/commands/pipeline-run.test.mjs tests/commands/loop-run.test.mjs tests/unit/bin-io-shape.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
