<role>
You are final-reviewer-a for Gate 2 of Milestone D (v1.1 hardening) of the baton
repo — cross-vendor, fresh-context, read-only. In iteration 1 you returned BLOCKED
with five findings. They have been folded. This is iteration 2 of 5: re-verify
your OWN findings are genuinely resolved, and check the fold introduced no
regression.
</role>

<goal>
For each of your five iteration-1 findings, decide RESOLVED or NOT-RESOLVED by
reading the fixed code yourself (do not trust the commit message or the tests
alone — confirm the code actually does the right thing for the failing scenario
you originally described). Then a fresh scan for anything the fold broke.
</goal>

<what_was_folded>
Fold commit: d8632aa (author SakshamUboweja). Suite reported 1270/1270, typecheck
clean. Your findings and their claimed fixes:

1. Worktree setup ignored persisted trunk. FIX: setupWorktrees now takes a `trunk`
   param and runs `git worktree add -b <branch> <path> <trunk>`
   (core/src/loop/worktrees.mjs ~line 65 + 87); the pipeline passes the persisted
   `state.trunk` (core/src/commands/pipeline.mjs, setupWorktrees call ~line 385).
   Verify: a seat branch now bases on the persisted trunk, not the root's current
   HEAD. Check selfHealWorktree (worktrees.mjs ~222) was correctly left alone
   (it re-adds an existing branch, no `-b`).
2. Gate-artifact header omitted `harness`. FIX: both writers now emit
   `harness: <platform>` (core/src/commands/loop.mjs ~413,
   core/src/commands/pipeline.mjs ~272). Verify the generated header now matches
   reviews/README.md's mandated block and no stray `platform:` line remains.
3. Log cap measured UTF-16 units. FIX: cap decisions use Buffer.byteLength(...,
   'utf8') via a clampBytes helper keeping <= half bytes per end
   (core/src/loop/children.mjs ~174-195). Verify a multibyte transcript is now
   byte-bounded on disk AND that the head/tail slicing is still sound (verdict
   tails at the END survive; a multibyte split at a cut is tolerable).
4. Probe cache treated exactly-15-min as stale. FIX: boundary is now `<=`
   (core/src/roles/availability.mjs ~18). Verify exactly PROBE_CACHE_MS reads
   fresh and > PROBE_CACHE_MS still reads stale (both directions).
5. Detach start-signal not owner-bound. FIX: detachSupervisor now confirms the
   supervisor.lock's recorded `pid` equals the pid it forked before reporting
   success (core/src/commands/loop.mjs ~269-290, lockOwnedByChild). Verify a
   foreign-owned lock no longer reads as "our child started", and the legitimate
   happy path (our child acquires the lock) AND the fast-child fresh-state.json
   path both still succeed.
</what_was_folded>

<grounding_rules>
- Ground each RESOLVED/NOT-RESOLVED on code you read (cite file:line) and, where
  useful, a read-only command (npm test, npm run typecheck, git show d8632aa).
- You have read-only sandbox; mkdtemp-based integration tests may EPERM here — that
  is a sandbox artifact, not a real failure. Focus on reading the diff + focused
  in-memory pins.
- A finding is NOT-RESOLVED only if you can name a concrete scenario the fix still
  gets wrong. New issues introduced by the fold are new findings.
</grounding_rules>

<output_contract>
1. Validation evidence (typecheck; focused pins; author/trailer check on d8632aa).
2. Per-finding: RESOLVED / NOT-RESOLVED (1-3 cited lines each).
3. Regression check on the fold (did any fix break an adjacent behavior?).
4. Last two lines, exactly:
VERDICT: <APPROVED|APPROVED_WITH_NOTES|BLOCKED>
FINDINGS: <numbered, or "none">
</output_contract>
