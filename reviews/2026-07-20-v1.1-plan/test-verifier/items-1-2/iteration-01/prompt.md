<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, items-1-2 series iteration 1 of 5, auditing the Milestone-D build pins for plan items 1 (D9 done-status persistence) and 2 (trunk derivation) BEFORE implementation. Authority: docs/plans/2026-07-20-v1.1-hardening.md items 1–2 (Gate-1 approved). Uncommitted, tests-only: tests/commands/loop-run.test.mjs ("D9" block) + tests/commands/pipeline-run.test.mjs ("trunk derivation" block with a masterGit() fake that answers main refs leniently so a main-hardcoded impl runs end-to-end and the teeth are argv content). Claimed totals: suite 1216, 1210 pass / 6 red, guards green, typecheck green. NOTE: your sandbox cannot mkdtemp — integration files are environment noise; judge by reading.

The pins:
- D9 (RED): a smoke-approved run whose smoke gate sits on the FINAL phase completes exit 0 AND raw persisted state.json status === 'done' (today 'running'). GUARD green: re-running a done state prints done, exit 0, no spawn.
- trunk-1 (RED): master-trunk pipeline completes DONE with ZERO 'main' in recorded git argv; reviewer prompt uses git diff master..<branch>; merger prompt names master; receipt shape unchanged.
- trunk-2 (RED): the stale-branch park message points at git log master..<branch>.
- trunk-3a (RED): a fresh master run stamps state.trunk === 'master'.
- trunk-3b (RED): resume REUSES the stamp — with derivation disabled (deriveThrows), the run still completes on master.
- trunk-4 (RED): a stamped (flavor+specDigest) state WITHOUT trunk migrates additively — derived once and stamped, code !== 2 (contrast the I3 unstamped refusal).
- GUARD: no existing main-trunk test modified.

Audit adversarially:
1. Would a WRONG implementation pass? (a) D9 — could an impl flip done WITHOUT the smoke gate being on the final phase (i.e. is the fixture genuinely final-phase so the SMOKE_AWAIT-clobbers-DONE ordering is exercised)? (b) trunk-1 — is the lenient masterGit() fake genuinely lenient (a main-hardcoded impl must RUN, not crash, so the argv assertion is the only teeth), and is the zero-'main' scan over ALL recorded git argv including worktree setup/postflight/merge/ff-sync? (c) trunk-3b — does deriveThrows make BOTH derivation commands fail so only the stamp can supply master? (d) trunk-4 — does it assert the trunk is stamped AFTER the migrating resume and that nothing refused (not merely absence of crash)?
2. Red-phase integrity: 6 reds fail on behavioral assertions today (no ReferenceError/TypeError); guards meaningful; baseline 1209 unaffected.
3. Coverage vs plan items 1–2: any acceptance sub-item unpinned (e.g. the already-merged recognizer under master; receipts+resume paths under master)?

You may run: node --test tests/commands/pipeline-run.test.mjs tests/commands/loop-run.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
