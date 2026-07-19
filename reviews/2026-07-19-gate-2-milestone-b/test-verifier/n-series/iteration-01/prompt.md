<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, n-series iteration 1 of 5 — a SCOPED pass auditing the pins for the Gate-2 closure notes. Context: Gate 2 PASSED (reviewer-a APPROVED at iteration 4, reviewer-b APPROVED_WITH_NOTES at iteration 5 — reviews/2026-07-19-gate-2-milestone-b/reviewer-b/iteration-05/raw-output.txt); its three minor notes are being folded, and the behavioral ones are pinned BEFORE implementation. Uncommitted, tests-only: tests/commands/pipeline-run.test.mjs and tests/commands/loop-run.test.mjs. Baseline 4f53439. NOTE: your sandbox cannot mkdtemp — integration files are environment noise; judge by reading.

The pins (3 new, all RED today):
- J1e (pipeline): `baton pipeline resume` with a valid spec but NO persisted .handoff/loop/state.json refuses exit 2, message /nothing to resume/i pointing at `baton pipeline run`, zero spawns, AND no state.json created (a wrong-directory resume must not silently initialize a fresh run). Fails today 0 !== 2 (resume currently init-and-runs).
- G6 nothing-to-resume (loop): the same contract for `baton loop resume` (exit 2, /nothing to resume/i → `baton loop run`, zero spawns, no state.json created). Fails today 0 !== 2.
- G6 run-on-parked symmetry (loop): `baton loop run` on a parked state refuses exit 4 (already true) and the message must include /resume with: baton loop resume/ (pipeline's parked refusal already carries the equivalent pointer). New test — no existing test adjusted. Fails today on the pointer assertion.

Not pinned by design: the stale-park message rewording ("at main's tip" → "whose tip is already contained in main") — the existing I1a assertions (stale, both causes, git-log pointer, seat checkout) constrain it; confirm you agree no pinned phrase depends on the old wording.

Audit adversarially:
1. Would a WRONG implementation pass? (a) J1e / loop nothing-to-resume — is "no state.json created" genuinely asserted (an implementation that refuses AFTER initializing must fail), and are the refusals pre-spawn? (b) Does the loop-side pin also catch a leaked supervisor.lock on the new refusal path, and if not, is that acceptable given the I4 precedent (flag it if the pin should assert lock absence)?
2. Red-phase integrity: 3 reds fail on behavioral assertions (no ReferenceError/TypeError); no pre-existing regressions (claimed: 1190 total, 1187 pass).
3. Any note sub-item unpinned that should be?

You may run: node --test tests/commands/pipeline-run.test.mjs tests/commands/loop-run.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
