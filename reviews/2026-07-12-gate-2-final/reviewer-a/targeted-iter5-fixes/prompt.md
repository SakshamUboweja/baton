<task>
You are final-reviewer-a for the baton project — a TARGETED re-review of the three findings you raised at Gate-2 iteration 5 (reviews/2026-07-12-gate-2-final/reviewer-a/iteration-05/verdict.md). Saksham approved fixing them past the 5-iteration cap; this pass verifies ONLY those three fixes and any regression they introduced. Do not re-open the rest of the codebase.

The fixes are in the range 5731e43..HEAD (`git diff 5731e43..HEAD -- core/ tests/`). Verify each:

1. A1 (was BLOCKING) — core/src/commands/checkpoint.mjs snapshot rewrite: git is now captured BEFORE the lock, then a single withLock spans reload → apply git → writeSnapshotIn under the fence. Confirm the load-then-await-then-write TOCTOU is gone: a concurrent takeover during the await can no longer be clobbered. Check the deterministic regression test (tests/commands/checkpoint-pipeline.test.mjs — the "takeover landing DURING the git await" case). Any re-entrancy/deadlock from loadBundle inside withLock? (commit uses the same pattern.)

2. A2 (was major) — core/src/commands/finalize.mjs: git captured before the lock, then reload → seal → writeSnapshotIn → rotateJournalIn under ONE lock + fence. Confirm a decision appended during the git await now lands in the seal, not just the rotated journal. Check the regression test (tests/commands/finalize.test.mjs — "decision appended DURING the git await").

3. A3 (was major) — core/src/commands/doctor.mjs hookSurfaceCheck: enabled now requires the mechanical-checkpoint hook (codex Stop / cursor stop) to declare a `baton checkpoint` command (not any baton mention); observed requires a platform-sourced mechanical checkpoint; the ≤1-turn fidelity claim is gated on enabled AND observed. Confirm the semantics match the plan (§Codex/§Cursor trust gate) and the tests pin them (tests/commands/doctor.test.mjs).

Confirm the fixes did not weaken any test and introduced no new defect in these three files.
</task>

<grounding_rules>
Cite file:line. Read the code. Read-only sandbox: node --test on unit/command files works; mkdtemp integration tests EPERM — judge by reading. Scope strictly to A1/A2/A3 and their tests.
</grounding_rules>

<structured_output_contract>
End with exactly:

VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
DISPOSITIONS: A1 <closed|open>, A2 <closed|open>, A3 <closed|open>
FINDINGS:
1. [blocking|major|minor] — <file:line> — <what is wrong> — Fix: <specific change>
(one per finding; "none" if empty)
</structured_output_contract>
