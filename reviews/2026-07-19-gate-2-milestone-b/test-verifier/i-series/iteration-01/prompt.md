<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, iteration 1 of 5 in a NEW pin series (the Gate-2 iteration-3 fold, findings I1–I5 per the "Iteration 3" section of reviews/2026-07-19-gate-2-milestone-b/findings.md — read it first), auditing pins BEFORE implementation. Uncommitted: changes to tests/commands/pipeline-run.test.mjs and tests/commands/loop-run.test.mjs. Claimed totals: 8 new test bodies, 1 removed (old H7 advance test, superseded), 2 modified in place; suite 1182 with 1173 pass / 9 red; typecheck green. NOTE: your sandbox cannot mkdtemp — integration files are environment noise; judge by reading.

The pins:
- I1a (RED): a stale empty subtask branch at main's tip (merge-base --is-ancestor true, NO merge receipt) must PARK as stale instead of auto-advancing.
- I1b (GREEN): a receipt-backed already-merged subtask advances on resume (replaces the old H7 pin).
- I1c (RED): a clean merge persists a receipt {subtaskId, branch, mergedAt} to .handoff/loop/merges.ndjson right after mergeSubtask succeeds.
- I2a (RED): run-1-retired childId X + a fresh in-flight start record for the SAME childId X (pgid 9002) + dead lock → reclaim must kill 9002 (today the earlier retire masks it).
- I2b (RED): a normal (non-reclaim) lock acquisition truncates prior-invocation records from children.ndjson.
- I3 (RED, both suites): an EXISTING unstamped state.json (no flavor/specDigest) is refused exit 2 with the archive instruction, zero spawns; loop-side also asserts no leaked supervisor.lock.
- I4 (in-place): the two existing loop-side H5 refusal tests gained a !existsSync(supervisor.lock) assertion and flipped green→red (the refusal currently leaks the lock).
- I5 (RED): a lock whose pid is alive by a 1-arg check but whose (pid, startTime) pair fails pid-reuse verification is reclaimed as dead, not refused as live.

FIXTURE RECONCILIATION TO AUDIT (test modifications re-enter verification): three previously-green tests seeded hand-written unstamped states and were stamped with flavor:'loop' + specDigest of their spec's phases so I3 does not falsely trip them — (1) "recovery from a mid-run crash" ~line 416, (2) the resume (G6) seedState helper ~line 589, (3) the ESCALATION.md (H6) seed ~line 758 of tests/commands/loop-run.test.mjs. Verify these edits do NOT weaken what those tests originally pinned (same behavioral assertions, only the seed gained the stamp).

Audit adversarially:
1. Would a WRONG implementation pass? (a) I1a — is is-ancestor genuinely true in the fixture, so only receipt-gating (not dropping the ancestor check) can produce the park? Is there a companion keeping the plain empty-branch park intact? (b) I1b/I1c — is the receipt shape asserted through observable behavior (file content / advance-vs-park), not internal call spying, and could an impl advance on receipt-alone (skipping is-ancestor) and still pass? (c) I2a — is pgid 9002 genuinely "alive" via the processAlive fake so only retire-mask removal (truncation or run-unique ids) can trigger the kill? (d) I3 — refusal pinned BEFORE any spawn in both suites? (e) I5 — does the fixture make the 1-arg liveness answer differ from the (pid, startTime) answer, so only passing startTime can pass?
2. Red-phase integrity: 9 reds fail on behavioral assertions today (no ReferenceError/TypeError), the I1b green is meaningful, no pre-existing regressions beyond the 2 intentional I4 flips.
3. Coverage vs I1–I5: any sub-item unpinned? Is removing the old H7 test genuinely superseded by I1b (no lost coverage)?

You may run: node --test tests/commands/pipeline-run.test.mjs tests/commands/loop-run.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
