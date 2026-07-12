<task>
You are the test-verifier for the baton repository (cwd). Audit the test diff of the gate-2 ITERATION-3 fix wave: `git diff e4acd79..HEAD -- tests/` (9 files, ~410 added lines), and the production changes it pins: `git diff e4acd79..HEAD -- core/ adapters/`. These tests were written folding the 12 collated iteration-3 findings in reviews/2026-07-12-gate-2-final/findings-iter3.md (two independent reviewers). Per the TDD contract (AGENTS.md §4) every test change re-enters test-verifier review — this is that review.

Judge the TESTS: do they pin each fix and would they FAIL if the fix regressed? Name any hollow/complicit coverage, and judge whether the two intentionally-updated pre-existing pins are faithful contract updates or weakenings.
</task>

<verification_targets>
- F1 resolver eligibility (resolve.mjs): tests/unit/resolve-eligibility.test.mjs + the UPDATED pin in tests/unit/resolve.test.mjs (split into capped-success = selectable+degraded and verified-failure = skip). Faithful contract update, or weakened?
- F6+F9 Windows paths (pathnorm.mjs, jail.mjs, shared.mjs, checkpoint.mjs): tests/unit/pathnorm-windows.test.mjs — do the drive-root/backslash/cross-volume cases exercise the real comparison (hand-built io stub), and would they fail against the old forward-slash-hardcoded compare?
- F2 lock journaling (lock.mjs): tests/integration/lock-concurrency.test.mjs — the reclaim race now asserts at-most-one takeover + UNIQUE journal seqs; is the seq-uniqueness assertion a real guard against the under-lock-collision the finding described? Is the yield/timeout change honest (not masking a real hang)?
- F3 merge remap null (merge.mjs): tests/unit/merge-hardening.test.mjs — null-valued, non-object-valued, and valid remap cases.
- F4 doctor cache jail (doctor.mjs): tests/integration/doctor-cache-symlink.test.mjs — real-fs symlink + safe-tree control.
- F7 probe cover (probe.mjs): tests/unit/regex-hardening-2.test.mjs — the non-ASCII literal + escaped class-range chained-star cases; would they fail against the ASCII-only cover?
- F8/F11/F12: tests/commands/gate2-iter3-group6.test.mjs — subcommand-help envelope, reason-class enum rejection, SessionStart origin relabel (the hostile-origin case must prove no verbatim interpolation).
- F10 low-confidence seal (txn.mjs): tests/unit/receive-txn.test.mjs — the low-confidence-not-sealed and explicit-intake-still-seals cases.
</verification_targets>

<grounding_rules>
Read the diff and files before judging; cite file:line. You MAY run `node --test <file>` on unit/command files (read-only sandbox may EPERM on mkdtemp integration tests — note, don't fail, on sandbox EPERM; judge those by reading). Do not review implementation beyond judging whether a test is complicit or truly pins the fix.
</grounding_rules>

<structured_output_contract>
Output exactly:
1. VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
2. Numbered findings, most severe first: [blocking|major|minor] — file:line — one-sentence defect — one-sentence fix. "none" if empty.
3. A per-finding table: finding (F1,F2,F3,F4,F6,F7,F8,F9,F10,F11,F12) → pinned honestly? yes/partial/no + test file:line + would-fail-on-regression yes/no.
Keep under 110 lines.
</structured_output_contract>
