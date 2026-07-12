<task>
You are the test-verifier for the ADAPTERS wave of the baton project (repo root: current directory), iteration 2. In iteration 1 you returned BLOCKED with 10 findings (7 blocking, 3 major) — verdict at reviews/2026-07-12-wave-adapters/subtask-adapter-tests/iteration-01/verdict.md. All 10 were folded. Re-verify.

Files: tests/adapters/*.test.mjs (7 files, now 507 total suite / 476 pass / 31 adapter-fails; expected 531 when green).

Claimed folds (verify each against the actual test code):
1. assertBatonCall helper: every recorded core child call (checkpoint AND detect, swept per event) must include the resolved /repo/core/bin/baton.mjs and opts.input === io.stdin.
2. SessionStart pending matrix: foreign OPEN usage-limit → context; foreign OPEN non-limit → none; sealed-foreign → context; own-platform and no-bundle → none.
3. Skill-not-agent: no handoff-named agent under adapters/claude-code/agents/ and no /handoff/i agents override in plugin.json, anchored to stay red pre-implementation.
4. codex writer plans/writes .agents/skills/baton-handoff/SKILL.md with a read-not-embed sentinel, at module and command layers.
5. Legacy gating: default --codex plans nothing matching .codex/prompts, config.toml, or notify; withLegacyPrompts plans HOME/.codex/prompts/*.md; config.toml/notify never planned even with the flag; command layer pins the negatives (positive documented as module-layer only).
6. Codex merge: deepStrictEqual-membership survival of exact user entries for Stop/PreCompact/SessionStart + a foreign event, with per-event baton sentinel coexistence.
7. Cursor merge: same for all five cursor events + a foreign event; version 1 preserved.
8. Codex stamping: every Stop/PreCompact item = checkpoint --platform codex; every SessionStart item = receive --print-prompt --platform codex.
9. Cursor stamping: same pattern for cursor.
10. beforeShellExecution matcher must satisfy /git[^]*commit/i.

Authoritative contracts as iteration 1 (plan §adapters, platform-notes). The plan wins.
</task>

<grounding_rules>
Do not re-raise folded findings that are genuinely closed. New findings admissible only if a fold fails to close its original finding, introduces a defect or plan contradiction, or you missed a blocking-level plan-invariant gap in iteration 1 — not incremental hardening. Confirm red-state attribution (each file red only for its declared cause; the single justified positive-control pass; 475 pre-existing tests unaffected — if your sandbox blocks mkdtemp, note it; the orchestrator verified 475 locally).
</grounding_rules>

<structured_output_contract>
End your reply with exactly this block:

VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS:
1. [blocking|major|minor] — <file> / <test name> — <what is wrong> — <clause> — Fix: <specific change>
(one numbered line per finding; write "none" if there are no findings)
</structured_output_contract>
