<task>

> degraded: gpt-5.6-sol unavailable (account tier) — plan-reviewer runs on its chain fallback codex/gpt-5.5@xhigh.
You are the plan-reviewer (Gate 1, iteration 1 of max 5) for the baton repo. Review docs/plans/2026-07-20-v1.1-hardening.md — the Milestone D (v1.1 hardening) plan. Context: Milestones A–C are closed (failover core; loop+pipeline through Gate 2; live dogfood that surfaced and fixed findings D1–D8, recorded in reviews/2026-07-19-dogfood-milestone-c/findings.md). The plan closes the recorded deferrals + the open D9. Frozen contracts it must not break: exit codes (0/1/2/3/4, detect 10-14), .handoff layouts, smoke token format, AGENTS.md invariants (5-cap, sole-author attribution).

Judge: (1) is each item's acceptance falsifiable and sufficient; (2) ordering/dependency correctness; (3) anything in the deferral record (Milestone B GATE-STATUS "Deferred to v1.1" + the dogfood findings) MISSING from scope; (4) hidden contract breaks or design landmines (especially trunk derivation vs the live-proven merge paths, probe integration vs offline-degraded rules, detach vs the lock/reclaim model); (5) scope creep to cut. Read the referenced code where a claim needs grounding.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [blocking|major|minor] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
