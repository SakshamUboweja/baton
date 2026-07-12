<task>
You are final-reviewer-a for the baton project v1 (repo root: current directory) — Gate 2, iteration 4. Your iteration-3 review (reviews/2026-07-12-gate-2-final/reviewer-a/iteration-03/verdict.md) returned BLOCKED with 11 findings; combined with reviewer B's 6 they were deduplicated into the 12-item list in reviews/2026-07-12-gate-2-final/findings-iter3.md (see its fold-order table) and folded across commits 58b2e06..HEAD, with a consolidated test-verifier pass (iterations 3–5) adding regression coverage. All folds are on main: 768 tests green, typecheck clean, single author.

Re-review with two priorities, in order:
1. VERIFY THE DISPOSITIONS. For each of your 11 iteration-3 findings (mapped to F1–F12 in findings-iter3.md), check the fix actually closes it — read the implementation and its tests, not the commit message. The fix range is e4acd79..HEAD; `git diff e4acd79..HEAD --stat` orients you. Key items:
   - F1 resolver eligibility (core/src/roles/resolve.mjs): {installed, ok} is now selectable+degraded; only a verified failure (installed AND outcome!=='ok') skips as 'unauthenticated'.
   - F2 lock journaling (core/src/bundle/lock.mjs): the takeover note is now journaled AFTER publishOwner (under the held lock); recoverLock journals under a re-acquired withLock. Verify seq is allocated under the lock at both sites.
   - F3 (core/src/bundle/merge.mjs roles.remap value validation), F4 (core/src/commands/doctor.mjs cache write jailed via checkHandoffTree).
   - F6+F9 Windows paths: one shared helper core/src/util/pathnorm.mjs (normSep/joinNorm/isContained) used by jail.mjs, commands/shared.mjs (resolveRoot, drive-root), commands/checkpoint.mjs (transcript containment).
   - F7 (core/src/detect/probe.mjs cover derived from pattern literals), F8 (core/src/cli.mjs subcommand-help envelope), F10 (core/src/receive/txn.mjs low-confidence class not sealed), F11 (core/src/commands/receive.mjs reason-class enum), F12 (adapters/claude-code/scripts/hook.mjs sessionStart jail + origin allowlist).
2. REVIEW THE CHANGED SURFACE for regressions the fixes introduced — especially the shared pathnorm helper (any containment it now accepts that it should not, or refuses that it should not), the resolver degraded-flag change, and the lock journaling relocation.

Known-open items you should NOT raise: live cross-harness smoke tests (scheduled after this gate), Windows CI (no CI infra yet — flag only if the CODE would break on Windows), README/contract docs (docs phase), `baton wrap` (post-v1).
</task>

<grounding_rules>
Every finding must cite file:line (or file + function) plus the plan/design clause (docs/plans/2026-07-11-baton-v1.md) or the iteration-3 finding it relates to. Rank blocking/major/minor. Read the code — do not speculate from names. Read-only sandbox: node --test on unit files works; mkdtemp-based integration tests will EPERM — do not report those as failures, judge them by reading.
</grounding_rules>

<structured_output_contract>
End your reply with exactly this block:

VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
DISPOSITIONS: <n> of 11 iteration-3 findings verified closed; list any NOT closed by number
FINDINGS:
1. [blocking|major|minor] — <file:line> — <what is wrong> — <clause or iteration-3 finding #> — Fix: <specific change>
(one numbered line per finding; write "none" if there are no findings)
</structured_output_contract>
