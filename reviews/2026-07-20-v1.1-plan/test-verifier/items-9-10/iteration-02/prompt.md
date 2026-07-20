<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, items-9-10 series iteration 2 of 5, re-auditing the final feature pins after your iteration-1 BLOCKED verdict (4 findings; report: reviews/2026-07-20-v1.1-plan/test-verifier/items-9-10/iteration-01/raw-output.txt). Uncommitted, tests-only; baseline 0213eeb. The command suites + purge/unit run for you; the new integration file tests/integration/loop-detach.test.mjs is judged by reading (mkdtemp unavailable in your sandbox).

Claimed closures:
1. Item 9: TWO-subtask smoke fixture; smokeAwareIo records every non-git exec with a merges.ndjson snapshot; 9-1 asserts the smoke command ran exactly once and only AFTER both subtasks' merge receipts existed, and issued token === smokeApprovalToken(approval.inputs); new 9-2b: a bogus token with NO drift is refused (code !== 0, never done).
2. 10-3 ordering (loop + pipeline): ordered {kind:'kill'} + {kind:'fork'} in one shared log; assert the -9001 kill index precedes the fork index.
3. Item 10 parity + real spawn: pipeline parity reds added directly (10-2 live-lock no-fork, 10-3 dead-lock ordered reclaim, 10-5 capped supervisor.out seam args); ONE real-fs integration test (tests/integration/loop-detach.test.mjs, SKIP_WIN) exercising DEFAULT spawnDetached — a real `baton loop run --detach` in a temp repo whose phase role has no config entry (parks fast, no child binaries): parent returns 0, real supervisor.out written + bounded (≤2 MB), lock released on detached child completion.
4. Exact seam fields: 10-5 asserts spec.outPath + spec.maxBytes exactly.

Remaining flagged calls: seam io.spawnDetached(spec)->{pid} with outPath+maxBytes, parent-checks-lock/child-owns-lock (accepted); integration asserts supervisor.out EXISTS + bounded (truncation-under-load stays pinned by the seam maxBytes arg since a fast-parking child can't overflow on demand); pipeline parity by direct reds not shared-helper assertion.

Claimed totals: suite 1264, 1251 pass / 13 red, guards 9-4/9-5/10-4 green, typecheck green.

Scope: verify the 4 closures genuine (read loop-detach.test.mjs for the integration claims), red-phase integrity, guards meaningful, no weakening/regressions, and rule on the three remaining flagged calls. This is the final feature batch — distinguish genuinely blocking from implementation-absorbable; if the pins are sound, APPROVE.

You may run: node --test tests/commands/loop-run.test.mjs tests/commands/pipeline-run.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
