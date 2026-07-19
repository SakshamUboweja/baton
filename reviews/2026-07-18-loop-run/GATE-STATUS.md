# Test-verifier gate — subtask `loop-run`

Tests: `tests/commands/loop-run.test.mjs` (16: 14 red, 2 invariant guards) —
the supervisor command contract, driven through the injectable
`io.superviseChild` seam over the real loop modules.
Author: test-author role (claude-code/claude-opus-4-8 subagent).
Verifier: codex/gpt-5.5 @ xhigh, read-only `codex exec`.

| Iteration | Verdict | Findings |
|---|---|---|
| 1 | BLOCKED | 2 high (platform-inconsistent model-unavailable fixture; fake stale token), 2 medium (logPath fallback; retry-prompt continuity), 1 low (generic valueless-flag assertion) |
| 2 | **APPROVED** | none |

Gate passed at iteration 2 of 5. Implementation followed: the `run`
subcommand in `core/src/commands/loop.mjs` — precondition validation (exit 2,
zero spawns), provably-dead supervisor.lock (live pid refused exit 1),
phase driving via resolveRoles + buildChildArgv (per-child logs under
.handoff/loop/children/, budget-derived timeouts), BLOCKED → GATE_ITERATION
with findings carried into the retry prompt, the 5-cap spawning exactly five
attempts before escalating (ESCALATION.md, exit 3), the smoke gate
(smoke.cmd via io.execFile, SMOKE-REVIEW.md + digest-bound smk1 token,
awaiting exit 0; --approve-smoke recomputes and PARKS on drift, exit 4),
failover integration reading the child's log transcript (relaunch on the
resolver's next platform / park exit 4), and journal recovery that never
re-runs completed phases. Lock released per invocation. Suite 1080/1080
green, typecheck clean.
