<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, auditing RED-phase tests for subtask `loop-run` BEFORE implementation — the supervisor command composing spec/state/children/failover. Uncommitted new file: tests/commands/loop-run.test.mjs (16 tests: 13 red, 3 green strict-flag guards); suite 1080 with 1064 pre-existing green; typecheck green.

Contract (plan §"baton loop (Layer 2)", §"Smoke gate", §"Caps", §"Supervisor lifetime and recovery"): `baton loop run [--approve-smoke <token>]` — precondition failures exit 2 with ZERO spawns; supervisor.lock {host, pid, startTime, runId} with provably-dead recovery via io.processAlive (live → exit 1); phases driven via io.superviseChild ?? superviseChild with buildChildArgv specs for RESOLVED assignments; BLOCKED verdicts → GATE_ITERATION with findings fed into the retry prompt, 5-cap → exactly 5 spawns + escalated + ESCALATION.md + exit 3; smoke gate: run smoke.cmd via io.execFile, write SMOKE-REVIEW.md + smoke-approval.json (smk1. token), awaiting-smoke-approval exit 0, --approve-smoke verifies (stale refused, no spawn); failover: the child's LOG FILE transcript classified → runFailover decision applied (relaunch on new platform / park exit 4); journal recovery resumes without re-running completed phases; strict flags; BATON_SUPERVISED_CHILD does not suppress; --detach deferred to e2e.

Audit adversarially:
1. Would these pass against a WRONG implementation? Probe: (a) a supervisor that spawns the gate child a 6th time but discards the result (is the runner CALL COUNT pinned at exactly 5, not just final state?); (b) smoke approval that accepts any smk1.-prefixed string (is the stale-token fixture a REAL smk1 token with drifted inputs, not garbage?); (c) a resume that re-runs phase 0 (is the recovery fixture's runner queue arranged so a re-run would VISIBLY consume the wrong scripted result or overflow the queue?); (d) findings-in-retry-prompt — asserted on the actual prompt string passed to the runner?; (e) failover integration — does the test prove the transcript came from the LOG FILE (log content differing from result fields)?; (f) the live-lock fixture — is pid 55555 guaranteed alive via an injected io.processAlive, not a real-system accident?; (g) exit-code pins (3 escalated / 4 parked / 0 awaiting) — asserted everywhere they matter?
2. Seam soundness: io.superviseChild injection + io.processAlive — do these leave any untested production path that could diverge (e.g. opts passed to the runner — logPath under .handoff/loop/children/)? Flag under/over-pinning for the pipeline subtask that will reuse the machinery.
3. Fixture realism: spec/config/state/journal fixtures must satisfy the REAL validateLoopSpec/loadLoopState/resolveRoles (cross-check).
4. Red-phase integrity (reds fail for the right reason today — unknown subcommand) and idiom conformance.

You may run: node --test tests/commands/loop-run.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts (ran/read) from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
