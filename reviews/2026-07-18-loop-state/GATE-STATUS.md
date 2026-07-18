# Test-verifier gate — subtask `loop-state`

Tests: `tests/unit/loop-state.test.mjs` (22) + `tests/unit/loop-smoke-token.test.mjs`
(8) — 30 tests defining the loop state machine's API.
Author: test-author role (claude-code/claude-opus-4-8 subagent).
Verifier: codex/gpt-5.5 @ xhigh, read-only `codex exec`.

| Iteration | Verdict | Findings |
|---|---|---|
| 1 | BLOCKED | 3 high (per-gate cap unproven; unguarded SMOKE_APPROVE; token collisions), 3 medium (partial inputs; RESUME-from-escalated; seq/atomic idioms) |
| 2 | BLOCKED | 2 medium (missing-verified ≠ approved; persisted-seq assertions) |
| 3 | BLOCKED | 1 medium (contradictory assertion in the new test) |
| 4 | **APPROVED** | none |

Gate passed at iteration 4 of 5. Implementation followed:
`core/src/loop/state.mjs` — pure reducer with per-gate 5-cap escalation,
guarded smoke approval ({token, verified} events; missing/false verified
never resumes), RESUME only from parked, atomic tmp+rename snapshot,
seq-continuing journal appends, torn-tail-tolerant seq-dedup replay, and the
structured `smk1.` smoke-approval token (per-field digests, driftedInputs
naming, throws on partial compute / degrades on partial verify). Suite
1019/1019 green, typecheck clean.
