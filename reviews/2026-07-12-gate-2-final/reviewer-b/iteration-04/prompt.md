<task>
You are final-reviewer-b for the baton project v1 — Gate 2, iteration 4. You are a FRESH-CONTEXT reviewer independent of reviewer A. Your iteration-3 review (reviews/2026-07-12-gate-2-final/reviewer-b/iteration-03/verdict.md) returned BLOCKED with 6 findings; those + reviewer A's were deduplicated into the 12-item list in reviews/2026-07-12-gate-2-final/findings-iter3.md and folded across commits 58b2e06..HEAD (a test-verifier pass, iterations 3–5, added regression coverage). All folds are on main: 768 tests green, typecheck clean, single author.

The authoritative plan is docs/plans/2026-07-11-baton-v1.md (§Concurrency, §Threat model, §Role matrix, §Limit detector). Review priorities, in order:
1. HUNT FOR REAL DEFECTS in the changed surface (fix range e4acd79..HEAD; `git diff e4acd79..HEAD --stat` orients you). Correctness bugs, not style. Focus where the folds changed behavior:
   - core/src/roles/resolve.mjs — {installed, ok} now selectable+degraded. Is a genuinely unauthenticated platform still skipped? Is the degraded flag correct for every capability/outcome combination?
   - core/src/bundle/lock.mjs — takeover journaled after publishOwner (under the lock); recoverLock journals under a re-acquired withLock. Can a takeover/recovery note still collide seq with a real event? Does re-acquiring in recoverLock deadlock or double-journal?
   - core/src/util/pathnorm.mjs (new) — used by jail.mjs, shared.mjs (resolveRoot), checkpoint.mjs. Any containment it wrongly accepts (an escape it lets through) or wrongly refuses (a legitimate in-tree path)? Check normSep on edge inputs (bare root, UNC, trailing separators).
   - core/src/detect/probe.mjs — cover now derived from pattern literals. Any pattern whose catastrophic input char it still misses?
   - core/src/receive/txn.mjs — low-confidence class no longer sealed; verify no legitimate high-confidence class is dropped.
   - adapters/claude-code/scripts/hook.mjs — sessionStart jail + origin allowlist.
2. VERIFY YOUR 6 iteration-3 findings stayed closed (resolver eligibility, lock journal seq, probe cover, sessionStart origin, low-confidence seal, transcript Windows separator).
3. Confirm the zero-AI-attribution invariant and single-author history hold, and that no test was weakened to pass.

Known-open items you should NOT raise: live cross-harness smoke tests (scheduled after this gate), Windows CI (no CI yet — flag only if the CODE would break on Windows), README/contract docs (docs phase), `baton wrap` (post-v1).

Run `npm test` and `npm run typecheck` for execution evidence. Read the code — cite file:line for every finding. Do NOT modify files.
</task>

<output_contract>
Return ONLY your review as your final message (captured verbatim as the verdict). End with exactly this block:

VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS:
1. [blocking|major|minor] — <file:line> — <what is wrong> — <plan clause> — Fix: <specific change>
(one numbered line per finding; "none" if empty)
ATTRIBUTION: <pass|fail> — one line on author/AI-attribution check
TESTS: <the npm test tallies you observed, or "not run" with reason>
</output_contract>
