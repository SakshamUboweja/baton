<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, auditing the Gate-2 FOLD pins BEFORE implementation. Both Gate-2 reviewers BLOCKED milestone B (collation: reviews/2026-07-19-gate-2-milestone-b/findings.md — read it); the test-author added 22 tests (20 red / 2 green companions) across four suites plus comment hygiene in the e2e file. Uncommitted. Suite: 1160 total, 1140 pass, 20 fail; typecheck green. NOTE: your sandbox cannot mkdtemp, so integration files fail FOR YOU before test bodies — environment noise; judge those by reading.

The pins (cross-check each against the findings and the current implementation):
- G7 (loop-spec): smoke.cmd without a smoke-build phase rejected naming the phase; 2 green companions.
- G1 (loop-children): claude argv --model, --output-format json, and spec.cwd = opts.root on BOTH platforms; G5 claude reviewer allowlist carries scoped git-read Bash (diff/log/show) with no write tools; the claudeGrantsWrite helper refined so scoped git-read ≠ write.
- G2/G3/G5 (pipeline-run): cap>5 rejected before spawn; live supervisor.lock exit 1; stale subtask branch parks (no crash); second run resumes state (no cap refund); writer BLOCKED → retry without reviewer spawn; writer limit-banner → failover relaunch; empty branch → park; dirty REVIEWER seat parks pre-spawn; raw-deleted seat self-heals; claude worker-seat writer carries model + seat cwd. Stateful fake git extended with existingBranches + per-cwd dirtyCwds.
- B8/G4/G6 (loop-run): atomic run-lock via a readFileSync-seam gap injection (competitor not clobbered → exit 1); child-start {childId, pid, pgid, startedAt} records pinned to .handoff/loop/children.ndjson before spawn with superviseChild results carrying pgid; dead-lock reclaim kills recorded live orphan groups via io.processKill (group semantics, Math.abs(pid) === pgid); `baton loop resume` (PARKED → running continues; ESCALATED refused).

Audit adversarially:
1. Does each pin genuinely encode its finding (would the WRONG current behavior pass any of them)? Especially: (a) the B8 gap-injection — does it truly exercise the check→write race, and would an mkdir-exclusive implementation pass it?; (b) the G4 kill pin — does it distinguish group-kill from pid-kill and prove the record was written BEFORE spawn?; (c) the cap-refund pin — does the two-invocation flow genuinely accumulate (no state reset between runs)?; (d) the claudeGrantsWrite refinement — could it accidentally classify a write-capable allowlist as read-only?
2. Contract-change audit: the helper refinement and fake-git extensions must not weaken any pre-existing pinned assertion — verify the existing children/pipeline tests still test what they tested.
3. Red-phase integrity: the 20 reds fail against current code for the RIGHT reasons (cite a few); the greens are meaningful.
4. Coverage vs the findings: any G1–G7 sub-item with no pin at all? (G8–G13 are recorded deferrals — out of scope.)

You may run: node --test tests/unit/loop-spec.test.mjs tests/unit/loop-children.test.mjs tests/commands/pipeline-run.test.mjs tests/commands/loop-run.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
