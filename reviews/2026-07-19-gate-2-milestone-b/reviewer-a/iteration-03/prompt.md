<task>

> degraded: gpt-5.6-sol unavailable (account tier) — final-reviewer-a runs on its chain fallback codex/gpt-5.5@xhigh; cross-vendor independence vs reviewer-b (Claude) preserved.
You are final-reviewer-a (Gate 2, iteration 3 of max 5) for the baton repo, re-reviewing MILESTONE B after your iteration-2 BLOCKED verdict (2 blockings). Both were collated as H-groups (reviews/2026-07-19-gate-2-milestone-b/findings.md, "Iteration 2" section) and folded at commit 64e6cb5 through the TDD flow (14 new verifier-approved pins at pin-iteration 5; suite 1175/1175 green; typecheck clean).

Dispositions of YOUR iteration-2 findings:
- A1 (avoidEntries dropped between relaunches) → H2: the pipeline carries a per-subtask avoidEntries array into runFailover and updates it from decision.avoidEntries; an always-model-unavailable pin asserts models ['wa1','wa2'] exactly once each, in order, then PARK; failover is additionally budgeted at the seat's chain length (an always-usage-limit cross-platform pin proves bounded park, no ping-pong).
- A2 (append-only children.ndjson kills recycled pgids) → H3: a retire record {childId, endedAt} is appended the moment a child resolves (in-flight ordering pinned via onStart); dead-lock reclaim kills ONLY start-without-retire records (a retired child whose pgid processAlive claims is alive is pinned never-killed); plus H4 — the production bin io now defines a process.kill-backed processKill so real reclaims reap.

Also folded from reviewer-b (verify no regressions): H1 writer verdict-tail prompt; H5 {flavor, specDigest} state binding with refusals; H6 ESCALATION.md operator wording; H7 already-merged-branch resume advance; H8 lock/state runId correlation.

Re-review the changed surfaces (core/src/commands/{loop,pipeline}.mjs, core/src/loop/children.mjs, core/bin/baton.mjs, the four test files) against your iteration-1/2 concerns; raise only NEW or defective-disposition findings; judge severity for a v1 milestone gate (recorded deferrals in the plan's "Deferred from v1" section are not blocking). NOTE: your sandbox cannot mkdtemp — full npm test and integration files fail FOR YOU; judge by reading (locally 1175/1175 green).

You may run: npm run typecheck, node --test tests/unit/loop-children.test.mjs tests/unit/bin-io-shape.test.mjs tests/commands/loop-run.test.mjs tests/commands/pipeline-run.test.mjs.
</task>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [blocking|major|minor] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
