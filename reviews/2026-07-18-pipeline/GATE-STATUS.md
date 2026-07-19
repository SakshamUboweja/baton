# Test-verifier gate — subtask `pipeline`

Tests: `tests/commands/pipeline-run.test.mjs` (20, driven through the real CLI
router with a strict stateful fake git + the injectable child runner).
Author: test-author role (claude-code/claude-opus-4-8 subagent).
Verifier: codex/gpt-5.5 @ xhigh, read-only `codex exec`.

| Iteration | Verdict | Findings |
|---|---|---|
| 1 | BLOCKED | 3 high (reviewer-satisfiable writer assertion; single-reviewer coverage; leaky cap), 2 medium (unfalsifiable merger-never-merges; missing item validation), 2 low (zero-spawn guards; wt-a-anchored attribution) |
| 2 | BLOCKED | 1 high (pre/postflight guard composition unproven) |
| 3 | **APPROVED** | none |

Gate passed at iteration 3 of 5. Implementation:
`core/src/commands/pipeline.mjs` (+ `pipeline` routed in cli.mjs; `merger`
added to the read-only role set in children.mjs) — subtask validation
(missing/malformed/duplicate ids exit 2, zero spawns), setupWorktrees once,
per-subtask seat swap (checkout -b in the seat, preflight → write-capable
writer on the seat's worker chain → postflight → read-only subtask-reviewer
from the OTHER seat with its worker model → read-only merger re-check →
supervisor merge via mergeSubtask under the merge lock with ff-only seat
syncs). Review/merger BLOCKED → writer retries with findings (per-subtask
5-cap → escalated exit 3 + ESCALATION.md, no 6th spawn); pre/postflight
refusals, merge conflicts, and attribution failures park (exit 4). Both
subtasks merged → done exit 0. Suite 1131/1131 green, typecheck clean.
