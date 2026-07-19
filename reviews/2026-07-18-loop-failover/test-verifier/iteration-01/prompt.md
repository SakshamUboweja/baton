<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, auditing RED-phase tests for subtask `loop-failover` BEFORE implementation. Uncommitted new file: tests/unit/loop-failover.test.mjs (14 tests, all red via the M() guard; suite 1061 with 1047 pre-existing green; typecheck green).

Contract (plan §"Limit failover (the baton integration)" + §"Model-level failover"): runFailover(input) → decision. Non-limit exit → retry once then park (attempt-driven), no bundle transitions. Model-unavailable at spawn → dead {platform, model} added to avoidEntries, re-resolve to the SAME platform's next entry, relaunch, no seal/receive. Usage-limit → the ordered transaction on the REAL command machinery: loop position checkpointed into the bundle under the supervisor session BEFORE the seal; finalize with reasonClass usage-limit (degraded-open path also pinned); receive prepare+commit back-to-back with identical flags/session; zero .handoff/loop writes across the transaction (fs spy); injected window drift → one automatic re-prepare retry; second consecutive stale → park; relaunch assignment avoids the dead origin platform; total exhaustion → park with the classifier's resumeAt hint; deterministic from injected io. The test-author flags one design seam for your judgment: `hooks.beforeCommit()` — a test-only injection point used to mutate git state inside the prepare→commit window; production passes nothing.

Audit adversarially:
1. Would these pass against a WRONG implementation? Probe specifically: (a) an implementation that checkpoints the loop position AFTER sealing (does a test genuinely inspect the FROZEN/sealed artifact for the position, not just the live bundle?); (b) prepare and commit called with DIFFERENT intake flags (would any test catch it, e.g. via the stale-rejection semantics?); (c) a retry loop that retries MORE than once on repeated staleness; (d) relaunch assignment computed WITHOUT the dead platform in avoid (does a fixture make the dead platform the resolver's first choice so forgetting avoid visibly picks it?); (e) the no-write-window spy — does it cover the whole transaction span and all mutators?; (f) model-unavailable handling that also seals (the no-seal guard — is it asserted on the bundle files?); (g) a decision computed without consulting the classifier (are class fields pinned against the seeded signature table?).
2. The hooks.beforeCommit seam: is it acceptable (a test-only injection point that production ignores), or does it let a wrong implementation pass by only re-deriving inside the hook path? Judge and, if defective, name a better expression (e.g. drift injected via the io.fs layer before calling runFailover with a pre-staled token).
3. Fixture realism: seeded bundles/config/signatures must exercise the REAL loadBundle/finalize/receive validation (cross-check the fixtures against core/src/receive/txn.mjs token inputs and core/src/commands/finalize.mjs requirements).
4. API sanity for loop-run (subtask 9): decision shapes sufficient? Red-phase integrity and idiom conformance.

You may run: node --test tests/unit/loop-failover.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts (ran/read) from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
