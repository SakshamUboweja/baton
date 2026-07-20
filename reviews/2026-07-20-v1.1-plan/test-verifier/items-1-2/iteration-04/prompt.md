<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, items-1-2 series iteration 4 of 5, re-auditing the Milestone-D item 1+2 pins after your iteration-3 BLOCKED verdict (1 finding: trunk-3b missed alternate branch-read shapes; report: reviews/2026-07-20-v1.1-plan/test-verifier/items-1-2/iteration-03/raw-output.txt). Uncommitted, tests-only; baseline 0291e22.

Claimed closure: masterGit now classifies derivation attempts by STRUCTURED argv shared between dispatch and counters — isDerivationShape(args) counts (a) symbolic-ref naming refs/remotes/origin/HEAD, (b) rev-parse containing BOTH --abbrev-ref and HEAD in any order, (c) branch --show-current, (d) symbolic-ref HEAD; isSeatHeadProbe (form b in a seat cwd) is the ONLY exclusion; deriveThrows rejects every shape in non-seat cwds so arg-order variants can't fall through to the generic rev-parse catch-all; derivationCalls()/seatProbes() use the same classifiers; plain rev-parse main/master/HEAD still resolve (not derivation shapes).

Claimed totals: suite 1217, 1210 pass / 7 red (D9 + trunk-1..5), guards green, typecheck green. NOTE: your sandbox cannot mkdtemp — integration files are environment noise.

Scope: verify the closure is genuine (read the classifiers; confirm dispatch and counting genuinely share them), red-phase integrity, no weakening, no regressions. This is iteration 4 of 5 — distinguish anything genuinely blocking from residue the implementation phase can absorb; the derive-once teeth need to be sound, not infinitely adversarial.

You may run: node --test tests/commands/pipeline-run.test.mjs tests/commands/loop-run.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
