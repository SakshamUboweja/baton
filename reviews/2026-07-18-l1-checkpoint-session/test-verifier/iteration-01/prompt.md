<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, auditing RED-phase tests for subtask `l1-checkpoint-session` BEFORE implementation. Uncommitted test file: tests/unit/checkpoint-session-flag.test.mjs (12 tests: 8 red, 4 green invariant guards). No other file touched.

Contract (docs/plans/2026-07-18-goal-loop-worktree-pipeline.md, "Root + ownership discipline" + module layout): `baton checkpoint` gains `--session <hint>` so the loop supervisor checkpoints under its OWN stable session identity. Pinned by the test-author:
- `--session` joins the strict flag spec; garbled invocations still exit 2.
- Empty `--session ''` is a usage error naming the flag and containing "empty" (never a silent fallback to payload identity).
- Override: every event's effective hint becomes the flag value, stable (unstable:false), overriding an explicit payload session_id — asserted via persisted origin.sessionHint, origin.unstable, journal writerId.
- Ownership follows the overridden hint: seeding, first-party re-checkpoint, foreign rejection (payload deliberately claims the OWNER's id while --session X forces foreignness — proving decisions key on the flag), --take-over supersedes.
- Guard precedence: BATON_SUPERVISED_CHILD + --session stays the silent no-op (green, locks subtask-1 behavior).
- A checkpoint WITHOUT --session behaves exactly as today (regression negative).

Audit adversarially:
1. Would these pass against a WRONG implementation? (e.g. --session accepted but ignored; override applied to origin but not writerId; empty value silently treated as absent; foreign check still keyed on payload id; take-over not transferring to the flag hint.) Name any hole.
2. Are persistence assertions reading the REAL shapes? Cross-check core/src/commands/checkpoint.mjs, core/src/bundle/normalize.mjs, core/src/bundle/store.mjs and existing checkpoint tests.
3. Red-phase integrity: each red test fails today because --session is an unknown strict flag — do the assertions genuinely distinguish the target behavior from today's rejection (i.e., will they only pass when the real behavior exists, not merely when the flag stops erroring)?
4. Coverage gaps vs the contract; also confirm the 4 greens are meaningful invariants, not tautologies.

You may run: node --test tests/unit/checkpoint-session-flag.test.mjs, npm test, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts (ran/read) from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
