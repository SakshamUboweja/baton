<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, auditing RED-phase tests for subtask `pipeline` BEFORE implementation — the Layer-3 dual-worktree preset command. Uncommitted new file: tests/commands/pipeline-run.test.mjs (16 tests: 15 red, 1 green guard); suite 1127 with 1111 pre-existing green; typecheck green.

Contract (plan §"baton pipeline" + locked decision 2): `baton pipeline run` via cli.mjs reads loop.json requiring subtasks [{id, title}]; seats swap per subtask (index 0 → wt-a/worker-a, 1 → wt-b/worker-b); the writer runs write-capable in its seat cwd on baton/wt-<seat>/subtask-<id> (checkout -b in the seat); the reviewer is read-only from the OTHER seat's cwd carrying the other seat's worker model under the subtask-reviewer role; merger child (role merger) gates the merge but never issues git — the supervisor merges via the REAL mergeSubtask (attribution scan, merge at /repo under merge.lock, ff-only main per seat); review-gate 5-cap → escalated exit 3 + ESCALATION.md, no 6th spawn; conflict/attribution → park exit 4; both merged → done exit 0 with loop state/journal persisted; setupWorktrees once; usage errors exit 2 with zero spawns; BATON_SUPERVISED_CHILD child-only.

Audit adversarially:
1. Would these pass against a WRONG implementation? Probe: (a) seat alternation asserted on BOTH subtasks' writers (cwd + branch + model) or only one?; (b) reviewer read-only + other-seat cwd + other-seat model — all three pinned on the recorded argv?; (c) 'the merger child never issues git' — how is that proven (the fake runner doesn't run git; is the assertion that no merge git call precedes mergeSubtask's, or that merge git only appears with the supervisor's lock probe)? Is it falsifiable?; (d) the cap test — exactly N writer spawns pinned, merger never spawned?; (e) attribution park — asserted that NO 'merge baton/' git call landed?; (f) completion — state done via loadLoopState AND exit 0 AND both merges recorded?; (g) setupWorktrees-once — exactly two worktree adds across the whole run?
2. The stateful fake git (checkout -b modeling branch state): is its state machine coherent with how worktrees.mjs preflight reads branch/status (would the REAL preflight pass against it)? Cite the stub keys vs worktrees.mjs's actual git invocations.
3. Fixture realism vs the real modules (mergeSubtask lock probing, attributionScan LOG_FORMAT, children buildChildArgv shapes).
4. Red-phase integrity and idiom conformance.

You may run: node --test tests/commands/pipeline-run.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts (ran/read) from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
