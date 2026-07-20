# items-9-10 verifier iteration 3 — DEGRADED (codex unavailable)

model: claude-code/claude-opus-4-8 (fresh context) · harness: Claude Code · date: 2026-07-20
degraded: codex-unavailable, fresh-context-claude — the codex/ChatGPT account is fully
usage-limited (reset weeks out); the normal codex/gpt-5.5 test-verifier could not run.
Fallback per baton.config.json test-verifier chain (opus-4-8), run as a fresh-context
subagent. The interrupted codex attempt's partial output is not retained (it hit the
usage-limit error before any verdict).

## Grounding
- node --test tests/commands/loop-run.test.mjs tests/commands/pipeline-run.test.mjs → 12 RED
  (loop 10-1/10-2/10-3/10-5; pipeline 9-1/9-2/9-2b/9-3, 10-1/10-2/10-3/10-5); +1 integration red.
- npm run typecheck → clean. Guards 9-4/9-5/10-4 green.

## Closures (both GENUINE)
1. Detach integration fixture: 'work-role' with an empty chain passes validateLoopSpec
   (spec.mjs:84 gates on key presence, not chain length; matrix.mjs:34-58 accepts []),
   resolveRoles returns mode:'unavailable' (resolve.mjs:110-112), the detached supervisor
   parks via the no-eligible-assignment path (loop.mjs:461-467). Real-spawn assertions intact
   (parent exit 0, supervisor.out exists + ≤2MB, lock released, state persisted, tail hint).
2. pipeline 9-1 asserts io.__smokeRuns[0].line === spec.smoke.cmd — a hardcoded post-merge
   command can no longer pass.

VERDICT: APPROVED
FINDINGS: none
