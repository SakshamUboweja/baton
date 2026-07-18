<task>

> degraded: gpt-5.6-sol unavailable (account tier rejects 5.6 models as of 2026-07-18) — reviewer downgraded to codex/gpt-5.5@xhigh; cross-vendor independence preserved.
You are the plan-reviewer (Gate 1) for the baton repo. Review the NEW milestone plan at docs/plans/2026-07-18-goal-loop-worktree-pipeline.md — Layers 2+3 (goal-driven loop with review gates + dual-worktree adversarial write/review pipeline) built on the completed Layer 1.

Context you should read: AGENTS.md (methodology + invariants), baton.config.json (role matrix), docs/plans/2026-07-11-baton-v1.md (the Layer-1 plan whose seams this builds on), core/src/commands/ and core/src/receive/txn.mjs as needed to judge integration claims.

Judge adversarially:
1. Are the acceptance constraints falsifiable and sufficient? What failure mode do they miss?
2. The supervisor spawn contract (headless claude -p / codex exec children, verdict-tail parsing, detect-on-exit failover): what breaks in practice? Consider permission surfaces, zombie children, partial transcripts, concurrent state writes, the smoke-gate park/resume flow.
3. The dual-worktree discipline (two persistent worktrees, branch-jailed workers, merger-only main writes, ff-sync): identify race/corruption scenarios the plan does not handle.
4. Limit-failover integration: does the finalize→remap→receive→relaunch chain as described actually compose with the Layer-1 contracts (token binding, ownership adoption, avoid[])? Name any mismatch.
5. Hard invariants that must survive: zero AI attribution anywhere (including child commits in worktrees), never commit .handoff/, 5-iteration cap on every gate, roles resolved via the matrix never hardcoded.
6. Scope: is anything in-scope that should be deferred, or deferred that v1 of this milestone genuinely needs?
</task>
<grounding_rules>Cite file:line for every claim about existing code. Distinguish verified facts from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [blocking|major|minor] — <what is wrong> — Fix: <specific change>
</structured_output_contract>
