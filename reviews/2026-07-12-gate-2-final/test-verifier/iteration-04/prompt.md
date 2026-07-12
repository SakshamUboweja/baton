<task>
You are the test-verifier for the baton repository (cwd). This is a re-verification: the iteration-3 test-verifier returned BLOCKED with 5 findings (verdict in reviews/2026-07-12-gate-2-final/test-verifier/iteration-03/verdict.md). They were folded in commit HEAD (5126d3e). Audit the fold's test diff: `git diff 06f64d8..HEAD -- tests/` and the production changes it pins: `git diff 06f64d8..HEAD -- core/ adapters/`.

Two findings surfaced REAL production bugs that were fixed; three were test-honesty gaps. Judge whether each strengthened test now HONESTLY pins the fix and would FAIL if the fix regressed. Per the TDD contract (AGENTS.md §4) every test change re-enters test-verifier review — this is that review.
</task>

<verification_targets>
1. Finding 1 (lock reclaim) — core/src/bundle/lock.mjs dead branch changed from rm-then-mkdir to atomic rename-arbitration, with the takeover journaled at the rename win. Assess:
   - tests/integration/lock-concurrency.test.mjs: the new real-process two-reclaimer race. Are the barrier real, timeouts bounded, and assertions on PERSISTED state (order-file integrity for mutual exclusion; exactly-one takeover note)? Would a regression to non-atomic rm+mkdir make it fail? Is it deterministic (not timing-luck)?
   - tests/unit/lock-hardening.test.mjs: the white-box trace test (rename-aside → rm-aside → mkdir) and the ENOENT-loser test. Do they pin the rename primitive, or merely echo it?
2. Finding 4 (Windows realpath) — core/src/util/jail.mjs checkHandoffTree now separator-normalizes the realpath containment compare. tests/commands/gate2-iter2-group6.test.mjs adds in-tree/outside-root/cross-volume cases via a hand-built io.fs stub. Would these fail against the old hardcoded-forward-slash compare? Is the stub faithful (does it exercise the real comparison, not bypass it)?
3. Finding 2 (hook log jail) — adapters/claude-code/scripts/hook.mjs logHookError now guards with checkHandoffTree. tests/integration/hook-log-symlink.test.mjs is a real-fs symlink test. Does it prove no write through the linked path AND fail-open, with a normal-tree control proving the guard is symlink-specific (not blanket-disabling logging)?
4. Finding 3 (M4 vacuity) — tests/commands/gate2-iter2-group6.test.mjs M4 now uses a cursor-FIRST role so avoidance is observable. Is the assertion now discriminating (low-confidence keeps cursor selected; explicit/sealed high-confidence makes the role fall through to claude-code)?
5. Finding 5 (M7) — tests/integration/receiver-concurrency.test.mjs now has each receiver independently prepare its own receipt before the barrier, then race the commit. Is this the faithful competing-receivers race, with assertions on persisted generation/archive/loser-untouched?
6. Regression check on the fake: tests/helpers/memfs.mjs gained directory rename. Is the implementation correct (moves the node + all descendants; file rename unchanged) and does it not weaken any existing atomicity assertion?
</verification_targets>

<grounding_rules>
Read the diff and files before judging; cite file:line. You MAY run `node --test <file>` on unit/command files for execution evidence (read-only sandbox may EPERM on mkdtemp integration tests — note, don't fail, on sandbox EPERM; judge those by reading). Do not review implementation beyond judging whether a test is complicit or whether it truly pins the named fix.
</grounding_rules>

<structured_output_contract>
Output exactly:
1. VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
2. Numbered findings, most severe first: [blocking|major|minor] — file:line — one-sentence defect — one-sentence fix. Write "none" if empty.
3. A per-finding table: finding (1,2,3,4,5,memfs) → now pinned honestly? yes/partial/no + test file:line + would-fail-on-regression? yes/no.
Keep under 90 lines.
</structured_output_contract>
