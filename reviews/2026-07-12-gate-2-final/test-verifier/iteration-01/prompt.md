<task>
You are the test-verifier for the baton repository (cwd). Audit the ENTIRE test diff of the gate-2 fix wave: `git diff 373f0c1..HEAD -- tests/` (23 files, ~2150 added lines). These tests were written alongside fixes for the 16 collated gate-2 findings in reviews/2026-07-12-gate-2-final/findings.md. Per the repo's TDD contract (AGENTS.md §4) and finding 12, every test change re-enters test-verifier review — this is that review, consolidated.

Judge the TESTS, not the implementation. For each test file in the diff, assess:
1. Complicit patterns — tests that echo implementation values back (fake execFile input the code itself constructs, sentinel round-trips that prove nothing, assertions on argv instead of persisted state).
2. Weakened or deleted pins — especially tests/adapters/codex-templates.test.mjs and tests/adapters/cursor-templates.test.mjs (the V8/V9 SessionStart pins were changed from `receive --print-prompt` to `session-start` per finding 8) and tests/integration/e2e-failover.test.mjs (a small lockRetry budget was injected per finding 12). Decide whether each change is a legitimate contract update or a weakening.
3. Coverage vs the findings — for each of findings 6, 8, 9, 10, 11, 12, 13, 14, 15, 16: do the new tests actually pin the prescribed behavior, and would they fail if the fix regressed? Name any finding whose test coverage is hollow.
4. Test-infrastructure honesty — tests/helpers/memfs.mjs gained lstatSync/realpathSync (no symlink representation; real-fs symlink tests live in tests/integration/symlink-escape.test.mjs) and tests/helpers/fakeio.mjs gained a small default lockRetry. Are these fakes still faithful to the real contracts?
</task>

<grounding_rules>
Read the actual files and diff before judging; cite file:line for every claim. Run `node --test <file>` on specific files if execution evidence is needed (read-only sandbox may block mkdtemp in integration tests — note, don't fail, on sandbox EPERM). Do not review implementation code except as needed to judge whether a test is complicit. If uncertain about a finding, mark it explicitly as uncertain rather than guessing.
</grounding_rules>

<structured_output_contract>
Output exactly:
1. A verdict line: VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
2. Numbered findings, most severe first, each: [blocking|major|minor] — file:line — one-sentence defect — one-sentence prescribed fix.
3. A short coverage table: finding number (6,8,9,10,11,12,13,14,15,16) → covered honestly? yes/partial/no + the test file that covers it.
Keep total output under 120 lines.
</structured_output_contract>
