# Test-verifier gate — subtask `l1-resolver-entries`

Tests: `tests/unit/resolver-avoid-entries.test.mjs` (13) + new describes in
`classifier.test.mjs`, `signatures.test.mjs`, `envelopes.test.mjs` (23 new
tests total: 14 red, 9 invariant guards).
Author: test-author role (claude-code/claude-opus-4-8 subagent).
Verifier: codex/gpt-5.5 @ xhigh, read-only `codex exec`.

| Iteration | Verdict | Findings |
|---|---|---|
| 1 | BLOCKED | 1 high (order-satisfiable precedence fixture), 2 medium (inexact signature pin; dual-match label), 1 low (real-world-order case) |
| 2 | BLOCKED | 1 medium (reciprocal tuple-match guard) |
| 3 | **APPROVED** | none |

Gate passed at iteration 3 of 5. Implementation followed: `avoidEntries[]`
tuple-match skip (`why: 'avoided-entry'`, platform label wins dual matches,
@effort-insensitive base-model identity) in resolve.mjs; shipped
`codex/model-unavailable-account-tier` substring signature; classifier
precedence usage-limit > auth > model-unavailable > throttle > other-error;
detect exit 14 + `data.class`; signatures-loader class enum extended; hook
StopFailure acceptCodes gains 14; design-doc exit table updated. Suite
942/942 green, typecheck clean.
