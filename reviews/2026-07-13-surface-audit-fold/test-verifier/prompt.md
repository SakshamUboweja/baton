<task>
You are the test-verifier for the baton repo. A surface audit found 40 defects; the implementer folded them in the range 1c9f67d..HEAD. Per the TDD contract, every MODIFIED test re-enters your review, and new tests get audited for soundness.

Review `git diff 1c9f67d..HEAD -- tests/` (plus any source needed for context). Focus:

1. CONTRACT EVOLUTIONS — were any tests WEAKENED (a safety property silently dropped)?
   a. tests/unit/receive-txn.test.mjs + tests/integration/e2e-failover.test.mjs: double-commit changed from throws→alreadyCommitted idempotent success. Are zero-mutation and single-generation-bump still asserted? Is the idempotency keyed narrowly enough (receipt digest) that a COMPETITOR's token still rejects?
   b. tests/integration/receiver-concurrency.test.mjs M7: children now pass distinct --session. Does the race still prove mutual exclusion for genuinely distinct receivers?
   c. tests/commands/gate2-iter3-group6.test.mjs F12: moved from the hook shim to core cmdSessionStart. Do the three security properties (hostile-origin relabel, allowlist, symlink/unsafe-tree refusal) still hold at the new home? Is anything now UNCOVERED at the hook layer?
   d. tests/adapters/claude-code-hook-script.test.mjs SessionStart: inline-read tests replaced by delegation tests. Is stdout forwarding + fail-open pinned?
   e. tests/commands/init.test.mjs: --dry-run stray-token tests changed from warn+proceed to exit-2. Still fail-safe?
2. NEW TESTS (strict-flags, receive-audit-fixes, status-origin, hook-invocation-abs-path additions, checkpoint stdin tiers, doctor handoff-ignored, finalize class-gap warning) — would each actually RED on a regression of its fix? Name any that are tautological or that pin implementation details instead of contracts.
3. Any fold that landed WITHOUT a test.

Run `npm test` and `npm run typecheck` for evidence.
</task>
<grounding_rules>Cite file:line. Read the code. Scope to the diff range.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [severity] — file:line — issue — fix (or "none")
</structured_output_contract>
