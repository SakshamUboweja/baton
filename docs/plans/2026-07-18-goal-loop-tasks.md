# Milestone B build order (goal-loop + pipeline)

Plan: `2026-07-18-goal-loop-worktree-pipeline.md` (Gate 1 APPROVED,
iteration 4). Dependency-ordered subtasks; each runs the repo TDD cycle
(test-author → test-verifier → implement → commit) and lands as one or more
sole-author commits to main.

| # | Task ID | Scope |
|---|---|---|
| 1 | `l1-supervised-guard` | `BATON_SUPERVISED_CHILD` no-op guard in hook entrypoints, `checkpoint`, `session-start` (exit 0, no output, no bundle read/write) |
| 2 | `l1-checkpoint-session` | `checkpoint --session <hint>` flag: supervisor-owned stable session identity |
| 3 | `l1-resolver-entries` | `avoidEntries[]` entry-level avoidance in `roles/resolve.mjs` + `model-unavailable` signature class + same-platform-next-entry test |
| 4 | `roles-config` | Add `subtask-reviewer`, `merger`, `worker-a`, `worker-b` roles to `baton.config.json` + template |
| 5 | `loop-spec` | `loop/spec.mjs`: load/validate `loop.json` ({id, role} phases, role-existence check, budgets) + `baton loop init` scaffold (plan/apply, dry-run) |
| 6 | `loop-state` | `loop/state.mjs`: journal-replayable state machine, smoke-approval digest token, escalation/park records |
| 7 | `loop-children` | `loop/children.mjs`: spawn contract (platform → argv, stdin closed, process groups), timeout SIGTERM→SIGKILL, capped logs, region-bounded verdict parse, detect-on-exit |
| 8 | `loop-failover` | `loop/failover.mjs`: 8-step limit-death transaction, no-write window, one re-prepare retry, park-on-exhaustion |
| 9 | `loop-run` | `commands/loop.mjs`: supervisor state machine, smoke gate + `--approve-smoke <token>`, 5-cap park/escalate, run lock, journal recovery, `--detach` |
| 10 | `worktrees` | `loop/worktrees.mjs`: guarded git transactions, namespaced branches, pre/postflight, merge lock, ff-only sync, attribution range scan, prune self-heal |
| 11 | `pipeline` | `commands/pipeline.mjs`: dual-worktree preset over the loop engine |
| 12 | `e2e-acceptance` | Fixture-repo end-to-end suites for acceptance constraints 1–6 (incl. supervisor-death recovery, chained failover, no-residue teardown) |

Gate 2 (dual independent final reviews) after task 12.
