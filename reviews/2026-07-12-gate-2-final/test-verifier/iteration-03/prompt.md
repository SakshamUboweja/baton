<task>
You are the test-verifier for the baton repository (cwd). Audit the test diff of the gate-2 ITERATION-2 fix wave: `git diff a0e3dcd..HEAD -- tests/` (12 files, ~1090 added lines). These tests were written alongside fixes for the 15 collated iteration-2 findings in reviews/2026-07-12-gate-2-final/findings-iter2.md (the "Fix-wave dispositions" mapping is in that file's header and each commit body). Per the TDD contract (AGENTS.md §4) every test change re-enters test-verifier review — this is that review.

Judge the TESTS, not the implementation. For each new/changed test file, assess:
1. Complicit patterns — tests that echo implementation values, assert on argv instead of persisted state, or seed the answer they check.
2. Legitimately-updated pins vs weakenings — three pre-existing tests were intentionally changed because the CONTRACT changed under review: tests/commands/majors-minors.test.mjs (seed assertion strengthened from decision-text to origin/identity restoration), tests/commands/doctor.test.mjs (claude --version capability now "installed" not "reachable"), tests/unit/resolve.test.mjs (offline probes===null now flagged degraded). Decide whether each is a faithful contract update or a weakening.
3. Coverage vs each finding — B1 (atomic dead-lock reclaim), B2 (jail before lock/recover + race-tolerant walk), B3 (regex flags), B4 (nested validation + journal envelope guard), B6 (self-applying seed), M1 (git every rewrite), M2 (Windows paths), M3 (doctor dimensions + offline degraded), M4 (confidence gating), M5 (debounce under lock), M6 (envelopes), M7 (concurrent receiver), M8 (probe alphabet), B5 (receive.md), m1 (transcript jail). For each: do the tests actually pin the fix, and would they fail if it regressed? Name any hollow coverage.
4. Concurrency-test honesty — tests/integration/lock-concurrency.test.mjs and tests/integration/receiver-concurrency.test.mjs use real barrier-released child processes. Are the barriers real (both children provably reach the barrier before release), the timeouts bounded, and the assertions on persisted state rather than timing luck?
</task>

<grounding_rules>
Read the diff and files before judging; cite file:line. Run `node --test <file>` on specific unit/command files for execution evidence (read-only sandbox may EPERM on mkdtemp integration tests — note, don't fail, on sandbox EPERM; judge those by reading). Do not review implementation code except to judge whether a test is complicit.
</grounding_rules>

<structured_output_contract>
Output exactly:
1. VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
2. Numbered findings, most severe first: [blocking|major|minor] — file:line — one-sentence defect — one-sentence fix. Write "none" if empty.
3. A coverage table: finding (B1,B2,B3,B4,B6,M1,M2,M3,M4,M5,M6,M7,M8,B5,m1) → covered honestly? yes/partial/no + test file.
Keep under 130 lines.
</structured_output_contract>
