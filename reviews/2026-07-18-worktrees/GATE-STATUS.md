# Test-verifier gate — subtask `worktrees`

Tests: `tests/unit/loop-worktrees.test.mjs` (31, over a strict recording fake
git that rejects unstubbed invocations and probes the merge lock per call).
Author: test-author role (claude-code/claude-opus-4-8 subagent).
Verifier: codex/gpt-5.5 @ xhigh, read-only `codex exec`.

| Iteration | Verdict | Findings |
|---|---|---|
| 1 | BLOCKED | 3 high (author-only scan; permissive fake git; no seat-cwd isolation), 2 medium (unpinned shapes; lock hygiene) |
| 2 | BLOCKED | 2 high (destructive scan gaps; lock-during-merge unproven), 2 medium (format incoherence; single-seat teardown pass) |
| 3 | BLOCKED | 2 medium (format order; conflict-path cwd/lock + anchored ff-only) |
| 4 | **APPROVED** | none |

Gate passed at iteration 4 of 5. Implementation:
`core/src/loop/worktrees.mjs` — seat setup on baton/wt-(a|b)/ branches with
the .worktrees/ gitignore ensure-line (idempotent); seat-cwd pre/postflight
(missing/dirty/wrong-branch/main-moved refusals, zero destructive git);
full-range attribution scan (%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e —
author AND committer identity + doctor trailer patterns, offending commit
named); mergeSubtask (merge.lock acquired/released on every path, attribution
gate before merge, merge at /repo under the lock, conflict → abort + park,
ff-only 'main' sync once per seat cwd, non-ff = corruption); prune self-heal;
teardown of exactly both seats; branch jail on baton/wt-*. Suite 1111/1111
green, typecheck clean.
