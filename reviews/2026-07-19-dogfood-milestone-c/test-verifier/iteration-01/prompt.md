<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, d-series iteration 1 of 5, auditing the Milestone-C DOGFOOD fold pins BEFORE implementation. Context: the first live `baton pipeline run` parked and surfaced five findings, recorded with evidence in reviews/2026-07-19-dogfood-milestone-c/findings.md (read it first). Uncommitted, tests-only changes in tests/commands/pipeline-run.test.mjs, tests/commands/loop-run.test.mjs, tests/unit/loop-children.test.mjs, tests/unit/loop-failover.test.mjs. Claimed totals: suite 1201 (baseline 1190 + 11 new), 1194 pass / 7 red (D1×2, D2, D3, D4, D5×2), guards green, typecheck green. NOTE: your sandbox cannot mkdtemp — integration files are environment noise; judge by reading.

The pins:
- D1 (both command suites): a child log with a usage-limit signature buried in the BODY (~15-24 KB before the end — the live child's own README diff did this) but a clean exit-0 APPROVED tail → treated ok (pipeline proceeds to review; loop advances; NO failover). GUARD green: a banner in the TAIL still routes to failover. Placement is constant-neutral (not tuned to a hardcoded slice size).
- D2 (loop-children unit + a pipeline argv pin): write-capable codex child with opts.gitDir → argv carries `-c sandbox_workspace_write.writable_roots=…` naming the main .git; read-only codex children NEVER get it; the pipeline writer's recorded argv names the main .git while -C stays the seat cwd.
- D3 (loop-failover unit): a usage-limit failover against a FOREIGN-session (operator-owned) bundle: plain checkpoint attempt → rejection → retry WITH take-over → transaction completes with the sealed freeze carrying the checkpointed loop position and the run owning the fresh generation. GUARD: a same-session bundle triggers no take-over/archive. The retry detection regex is /took over|prior bundle archived/i (deliberately not matching the rejection message's own "rerun with --take-over" hint).
- D4 (pipeline): worker-a [wa1, wa2], wa1 always model-unavailable, wa2 BLOCKED-once-then-APPROVED → recorded writer --model sequence contains exactly ONE wa1 attempt (today: wa1,wa2,wa1,wa2 — the plain BLOCKED retry re-resolves from the chain head).
- D5 (both command suites): after a usage-limit failover, the received bundle's origin.sessionHint equals the runId itself (today 'loop-loop-<hex>').

Audit adversarially:
1. Would a WRONG implementation pass? (a) D1 — could an impl pass by skipping classification entirely (is the tail-banner guard strong enough to force classification to still run)? Is the buried-signature placement genuinely beyond any plausible tail slice? (b) D2 — is the writable-roots assertion tolerant of exact -c formatting without being satisfiable by merely mentioning the path elsewhere (e.g. in the prompt)? (c) D3 — could an impl always pass --take-over and still pass (does the same-session guard catch that)? (d) D4 — is exactly-one-wa1 asserted over ALL writer spawns? (e) D5 — asserted from the bundle artifact, not a log string?
2. Red-phase integrity: 7 reds fail on behavioral assertions today (no ReferenceError/TypeError); guards meaningful; no baseline regressions.
3. Coverage vs D1–D5: any sub-item unpinned?

You may run: node --test tests/commands/pipeline-run.test.mjs tests/commands/loop-run.test.mjs tests/unit/loop-children.test.mjs tests/unit/loop-failover.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
