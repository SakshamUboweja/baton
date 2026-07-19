# Test-verifier gate — subtask `e2e-acceptance`

Tests: `tests/integration/loop-pipeline-e2e.test.mjs` (7 real-fs/real-git
integration proofs of the milestone-B acceptance constraints).
Author: test-author role (claude-code/claude-opus-4-8 subagent).
Verifier: codex/gpt-5.5 @ xhigh, read-only `codex exec` (its sandbox cannot
mkdtemp; integration runs verified locally, closures verified by read).

| Iteration | Verdict | Findings |
|---|---|---|
| 1 | BLOCKED | 1 medium (snapshot-only recovery test), 1 low (vacuous main..main attribution assert) |
| 2 | **APPROVED** | none |

The suite ALSO surfaced two genuine implementation gaps (its intended
output — requirement-level reds confirmed by the verifier both rounds):

1. Constraint 5: `teardownWorktrees` orphaned `baton/wt-*/base` branches
   once seats moved to subtask branches. Fixed — teardown deletes the seat's
   current branch AND its setup base branch (namespace-jailed, tolerant of
   already-gone refs).
2. Constraint 2: the loop supervisor accumulated `avoid` across failovers,
   so a chained A→B→A limit death parked with every platform avoided.
   Fixed — platform avoidance is per-death (runFailover avoids the just-died
   platform itself); entry-level avoidEntries still accumulate.

Final: 7/7 integration tests green (pipeline sole-author real merges +
per-subtask attribution ranges; foreign-author block; single + CHAINED
A→B→A limit failover with real .handoff artifacts; journal-replay
supervisor-death recovery; no-residue teardown). Suite 1138/1138 green,
typecheck clean.
