# Test-verifier gate — subtask `loop-children`

Tests: `tests/unit/loop-children.test.mjs` (25) +
`tests/integration/loop-children-spawn.test.mjs` (3 real-process) — 28 tests
defining the child-supervision contract.
Author: test-author role (claude-code/claude-opus-4-8 subagent).
Verifier: codex/gpt-5.5 @ xhigh, read-only `codex exec`.

| Iteration | Verdict | Findings |
|---|---|---|
| 1 | BLOCKED | 1 high (last-marker no-fallback unpinned), 3 medium (result shape; CI robustness/win32; delegation proof), 1 low (partial-tail cap) |
| 2 | BLOCKED | 1 medium (final-reviewer-b uncovered in read-only assertions) |
| 3 | **APPROVED** | none |

Gate passed at iteration 3 of 5. Implementation followed:
`core/src/loop/children.mjs` — buildChildArgv (5 reviewer roles read-only on
both platforms; supervised+sole-author env; stdin closed), region-bounded
parseVerdict (codex last-tokens-used region, claude JSON result field,
prompt-echo-proof, last-tail-wins, unparseable→BLOCKED), capLog
(head+marker+verbatim tail), classifyChildExit (delegates to core classify),
superviseChild (detached process group, SIGTERM→grace→SIGKILL of the whole
group — zombie-grandchild reaping proven with real processes, exitCode null
on kill, capped log). Suite 1047/1047 green, typecheck clean.
