<task>
You are the test-verifier for wave D of the baton project (repo root: current directory). Failing-first tests were just authored for the final core wave — implementation does not exist yet; each file failing with ERR_MODULE_NOT_FOUND for its own target module is the expected red state, not a finding.

Files under review (the complete wave-D set):
- tests/unit/scaffold-gitignore.test.mjs (target core/src/scaffold/gitignore.mjs)
- tests/unit/scaffold-managed-block.test.mjs (target core/src/scaffold/managed-block.mjs)
- tests/unit/scaffold-attribution.test.mjs (target core/src/scaffold/attribution.mjs)
- tests/commands/init.test.mjs (target core/src/commands/init.mjs; scaffold plan module per docs/design/core.md)
- tests/commands/doctor.test.mjs (target core/src/commands/doctor.mjs)
- tests/commands/purge-transcript.test.mjs (target core/src/commands/purge-transcript.mjs)
- tests/invariants/attribution.test.mjs (target core/src/scaffold/plan.mjs)
- tests/integration/e2e-failover.test.mjs (real-fs e2e; target core/src/commands/init.mjs)

Authoritative contracts (the plan wins over any test pin that contradicts it):
- docs/plans/2026-07-11-baton-v1.md — §Scaffold (two-phase plan/apply, --dry-run, ensure-line, managed blocks, bytes outside markers never touched), §Attribution guard (three layers: init deep-merge only-when-absent + refuses malformed JSON; doctor git-guard last 50 commits word-boundary-safe; test-suite invariant over rendered outputs/templates), §Role matrix availability probing (capability ladder installed→authenticated→reachable SEPARATE from outcome ok|rate-limited|error|timeout, 3 s probe bound, 15-min cache), §Transcript policy (purge removes the field from EVERY retained copy — active, .bak, journal rewrite-and-rotate under lock, all history freezes; whole-tree planted-secret test; marker-based interruption recovery), §Journal rotation & crash recovery, §Concurrency (dual writers, provably-dead takeover, competing receivers, prepare-without-commit), Acceptance constraints 1/2/5/6 (e2e kill-mid-write survival, six-direction contract tests, zero-attribution invariant, concurrency suite).
- docs/design/core.md — module APIs and per-module test lists for scaffold/{plan,gitignore,managed-block,attribution}.mjs, commands/{init,doctor,purge-transcript}.mjs, and the e2e test.
- Existing conventions: frozen exit-code contract, --json single-envelope, hook-safety, tests/helpers (memfs __history, fakeio, golden).
</task>

<grounding_rules>
Every finding must cite the specific test file + test name and the specific plan/design clause it violates or fails to cover. No style preferences. Acceptable pinning of open details is not a finding unless it would force a plan violation. Note: the test-author reconciled the module layout to docs/design/core.md's file tree (scaffold/{plan,gitignore,managed-block,attribution}.mjs — no scaffold/init.mjs); treat core.md as correct there.
</grounding_rules>

<verification_loop>
1. Coverage: for each module, compare authored tests against the plan's named requirements and core.md's test lists. Missing contractually-required cases are findings (blocking if a plan invariant, major otherwise).
2. Correctness of pins: any test asserting behavior the plan forbids (e.g. attribution merge clobbering user values, purge missing a retained copy, probe dimensions collapsed into one field, doctor probes unbounded, e2e allowing a remap onto the dead origin) is blocking.
3. Red-state attribution: each new file fails only on its own missing target module; the 383 existing tests are unaffected.
4. Test strength: would a trivially-wrong implementation pass? No-mutation and idempotency claims must assert full-tree/byte identity; the git-guard test must include both a true positive and a word-boundary near-miss; the planted-secret purge test must walk the whole .handoff tree.
5. e2e: verify the six-direction matrix, kill-mid-write, chained A→B→C with post-receive checkpoints, and the concurrency cases are all genuinely present and assert outcomes (not just absence of throws).
</verification_loop>

<structured_output_contract>
End your reply with exactly this block:

VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS:
1. [blocking|major|minor] — <file> / <test name> — <what is wrong> — <plan/design clause> — Fix: <specific change>
(one numbered line per finding; write "none" if there are no findings)
</structured_output_contract>
