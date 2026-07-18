<task>
You are the test-verifier for baton, re-verifying ONLY your three iteration-1 findings, folded in commit 5dae7dd (`git diff 79d2549..HEAD -- tests/`):
1. [high] F12: does tests/commands/gate2-iter3-group6.test.mjs now prove the NO-READ property (spy asserts nothing under /repo/.handoff/ is read through the symlinked tree), not just empty stdout? Would it red if loadBundle read before the jail check?
2. [medium] strict-parse table in tests/unit/strict-flags.test.mjs: does it cover every command migrated to parseFlagsStrict, and would one command regressing to lenient parsing actually red?
3. [low] tests/adapters/claude-code-hook-script.test.mjs: are the tautological seeded-bundle SessionStart negatives gone, replaced by a real hook-layer invariant?
Run `node --test` on the three files for evidence. Do not re-open anything else.
</task>
<grounding_rules>Cite file:line. Read the code.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
DISPOSITIONS: F1 <closed|open>, F2 <closed|open>, F3 <closed|open>
FINDINGS: numbered [severity] — file:line — issue — fix (or "none")
</structured_output_contract>
