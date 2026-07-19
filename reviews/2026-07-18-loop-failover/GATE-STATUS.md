# Test-verifier gate — subtask `loop-failover`

Tests: `tests/unit/loop-failover.test.mjs` (17, driving the real
checkpoint/finalize/receive/resolver machinery over memfs).
Author: test-author role (claude-code/claude-opus-4-8 subagent; interrupted
once by a real Claude session limit mid-fold and resumed after reset).
Verifier: codex/gpt-5.5 @ xhigh, read-only `codex exec`.

| Iteration | Verdict | Findings |
|---|---|---|
| 1 | BLOCKED | 2 high (unfalsifiable checkpoint-before-seal; accidental avoidance pass), 3 medium (retry cap uncounted; classifier delegation; weak hook seam) |
| 2 | BLOCKED | 1 high (sealed vs degraded-open fixtures conflated) |
| 3 | APPROVED (red phase) | none |
| 4 | **APPROVED** (scoped: historyFreezes .json filter + implementation spot-check) | none |

Gate passed. Implementation: `core/src/loop/failover.mjs` — table-driven
classification; retry-once-then-park for non-limit; model-unavailable →
entry-level avoid + same-platform re-resolve (no seal); usage-limit → the
exact transaction (loop position checkpointed into the bundle under the
supervisor session BEFORE the seal; finalize usage-limit unless
degradedOpen/already-sealed; receive prepare+commit with identical intake and
per-phase fresh git — exactly one stale retry, then park; relaunch avoids the
dead origin; exhaustion parks with the classifier's resume-at hint; zero
.handoff/loop writes). Suite 1064/1064 green, typecheck clean.
