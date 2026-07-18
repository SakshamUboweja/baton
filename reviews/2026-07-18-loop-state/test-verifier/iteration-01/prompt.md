<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, auditing RED-phase tests for subtask `loop-state` BEFORE implementation. Uncommitted new files: tests/unit/loop-state.test.mjs (14) and tests/unit/loop-smoke-token.test.mjs (5); all 19 red via the dynamic-import M() guard; 989 pre-existing green; typecheck green.

Contract (plan: docs/plans/2026-07-18-goal-loop-worktree-pipeline.md §"baton loop", §"Smoke gate", §"Supervisor lifetime and recovery", §"Caps"): core/src/loop/state.mjs — .handoff/loop/{state.json, journal.ndjson}; pure reducer applyLoopEvent over events PHASE_ADVANCE/GATE_ITERATION/PARK/RESUME/SMOKE_AWAIT/SMOKE_APPROVE; deterministic initLoopState(spec, io); atomic writeLoopState; appendLoopEvent returning seq; loadLoopState = snapshot + torn-tail-tolerant replay with seq dedup (no double-increment on replay); the 5-cap: a 6th GATE_ITERATION on one gate → status 'escalated' + escalation {gate, iteration}, never applied; status enum running/awaiting-smoke-approval/parked/escalated/done; smokeApprovalToken over the six bound inputs (stateDigest, smokeCmd, smokeOutputDigest, gitHead, gitContentDigest, childAssignment) with verifySmokeToken naming driftedInputs; no writes escape .handoff/loop/.

Audit adversarially:
1. Would these pass against a WRONG implementation? Specifically: a reducer that mutates its input state; a 5-cap that escalates at the 5th (not 6th) iteration or counts globally instead of per-gate; replay that re-applies events with new seqs (double-increment) — is the dedup pin real?; a token that concatenates inputs without separators (collision: {a:'x', b:'yz'} vs {a:'xy', b:'z'}); verifySmokeToken returning ok for a token computed from PARTIAL inputs; SMOKE_APPROVE accepted while status is not awaiting-smoke-approval or with a stale token; RESUME from 'escalated' (should it be allowed? check what the tests pin and whether that matches the plan's park-vs-escalate distinction).
2. Crash-recovery integrity: does the snapshot-stale/journal-ahead equality test genuinely exercise replay (snapshot older than journal), or would a load that ignores the journal pass?
3. API sanity for consumers (loop-run subtask 9, failover subtask 8): the no-write-window assertion in the failover plan needs state writes to be observable — is the API adequate? Flag over/under-pinning.
4. Red-phase and idiom conformance (memfs history spy, io.now determinism, bundle-journal seq/dedupe parallels — cross-check core/src/bundle/store.mjs and core/src/util/jsonl.mjs).

You may run: node --test tests/unit/loop-state.test.mjs tests/unit/loop-smoke-token.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts (ran/read) from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
