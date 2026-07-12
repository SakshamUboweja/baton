<task>
You are the test-verifier for the ADAPTERS wave (repo root: current directory), iteration 3. In iteration 2 you returned BLOCKED with exactly 3 findings; all three fixes were applied verbatim as you prescribed. Verify ONLY those fixes plus red-state attribution — everything else is settled from iterations 1–2.

The fixes:
1. tests/adapters/claude-code-hook-script.test.mjs — two new own-platform negatives: (a) own-platform SEALED bundle → no additionalContext, no checkpoint; (b) own-platform OPEN usage-limit bundle → no additionalContext, no checkpoint. Together with the existing foreign positives/negatives this proves "sealed or limit-hit AND foreign" exactly.
2. tests/adapters/codex-templates.test.mjs — the stamping test now validates BOTH item.command and the Windows override (commandWindows/command_windows) with identical per-event expectations (checkpoint --platform codex for Stop/PreCompact; receive --print-prompt --platform codex, never checkpoint, for SessionStart).
3. tests/adapters/cursor-templates.test.mjs — EVERY beforeShellExecution item's matcher must satisfy /git[^]*commit/i (loop over all items, non-empty required), replacing the `some`-based check.

Red-state check (verified locally by the orchestrator): suite 507 tests / 476 pass / 31 adapter-fails; hook-script file still fails only on ERR_MODULE_NOT_FOUND for adapters/claude-code/scripts/hook.mjs; typecheck clean.
</task>

<grounding_rules>
Scope is the three applied fixes + red-state attribution. A finding is admissible only if a fix fails to close its iteration-2 finding or introduces a defect.
</grounding_rules>

<structured_output_contract>
End your reply with exactly this block:

VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS:
1. [blocking|major|minor] — <file> / <test name> — <what is wrong> — <clause> — Fix: <specific change>
(one numbered line per finding; write "none" if there are no findings)
</structured_output_contract>
