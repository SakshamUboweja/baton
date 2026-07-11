<task>
You are the test-verifier for wave C2 of the baton project (repo root: current directory). Failing-first tests were just authored for six not-yet-implemented modules. Audit the TESTS ONLY — implementation does not exist yet and every target-module import failing with ERR_MODULE_NOT_FOUND is the expected red state, not a finding.

Files under review (the complete C2 set):
- tests/unit/normalize.test.mjs
- tests/unit/git-snapshot.test.mjs
- tests/unit/receive-prompt.test.mjs
- tests/unit/receive-txn.test.mjs
- tests/commands/checkpoint.test.mjs
- tests/commands/finalize.test.mjs
- tests/commands/receive.test.mjs
- tests/helpers/fixtures/golden/resume-prompt.txt (new golden)

Authoritative contracts to audit against (plan wins over any test pin that contradicts it):
- docs/plans/2026-07-11-baton-v1.md — especially: Concurrency (receive prepare/commit transaction, token bindings incl. content-sensitive git digest, ownership adoption + generation increment, open→received degraded seal, chained failover, competing receivers, double-commit), Checkpoint engine (normalize never throws, unknowns degrade to note, dedupe keys, hook-safety exit 0 on soft failures, --strict, snapshot throttling ≥10 events / 30 s / important types, foreign-sessionHint rejection + --take-over), sessionHint derivation (unstable hints never trigger foreign-session rejection alone), Receive (resume prompt ≤2500 chars, claims-as-unverified framing, staleness checks), finalize (--reason required, reason-class inferred via classifier when omitted, journal rotation marker order, history retention).
- docs/design/core.md — module APIs and per-module test lists for normalize.mjs, git/snapshot.mjs, receive/txn.mjs, receive/prompt.mjs, commands/checkpoint.mjs, commands/finalize.mjs, commands/receive.mjs.
- Existing conventions: tests/helpers/ (memfs, fakeio, golden.mjs), existing unit/command/integration suites, frozen CLI exit-code contract (0/1/2/10/11/12/13), --json single-envelope contract.
</task>

<grounding_rules>
Every finding must cite the specific test file + test name and the specific plan/design clause it violates or fails to cover. Do not report style preferences. Do not propose new architecture. If a test pins a contract detail the plan leaves open, that is acceptable pinning, not a finding — flag it only if it would force a plan violation. The plan document is the source of truth; if a test contradicts it, that is blocking.
</grounding_rules>

<verification_loop>
Checks to perform, in order:
1. Coverage: for each of the six modules, compare authored tests against the plan's named requirements and docs/design/core.md test lists. Missing contractually-required cases are findings (blocking if the requirement is a plan invariant, major otherwise).
2. Correctness of pins: any test asserting behavior that contradicts the plan (e.g. mutation on failed commit, generic nonzero exit treated as usage-limit, foreign unstable sessionHint causing rejection, prompt >2500 chars tolerated) is blocking.
3. Red-state attribution: confirm each new file's failure is solely the missing target module (no load-time errors, no accidental dependence on other unimplemented modules).
4. Test quality: assertions strong enough to prevent a trivially-wrong implementation from passing (e.g. token binding tests must vary exactly one bound input per rejection case; zero-mutation claims must be asserted against the full fs state, not a single file).
5. Golden: resume-prompt.txt matches the documented prompt format (≤2500 chars, claims line, HANDOFF.md pointer, role table with Mode column, em-dash for nulls, single trailing newline).
</verification_loop>

<structured_output_contract>
End your reply with exactly this block:

VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS:
1. [blocking|major|minor] — <file> / <test name> — <what is wrong> — <plan/design clause> — Fix: <specific change>
(one numbered line per finding; write "none" if there are no findings)

BLOCKED only if any blocking finding exists. APPROVED_WITH_NOTES for major/minor-only findings the implementer can fold in.
</structured_output_contract>
