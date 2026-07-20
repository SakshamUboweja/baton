# Gate 2 — Milestone D (v1.1 hardening) — CROSS-VENDOR re-review, findings

Cross-vendor arm run 2026-07-20 after the codex account recovered. The original
Gate 2 (reviews/2026-07-20-v1.1-plan/gate-2/) was degraded Claude-only and found
NO blockers; this cross-vendor pass found five, all confirmed real by reading the
code. This is the value of the cross-vendor requirement.

## Reviewers

| Reviewer | Model | Verdict |
|---|---|---|
| final-reviewer-a | codex/gpt-5.6-terra@max (read-only) | **BLOCKED** |
| final-reviewer-b | claude-code/claude-fable-5 (fresh, prior round) | APPROVED_WITH_NOTES |

Baseline at review: HEAD 059dfb3 · suite 1266/1266 · typecheck clean.
(Terra ran in a sandbox that EPERM-denied the 64 mkdtemp integration tests; those
pass on real fs — full suite is 1266/1266. Terra's focused in-memory pins:
237/237. Author/committer range check: sole author, no AI trailers.)

## Blocking findings (all confirmed against code)

1. **[blocking] Worktree setup ignores the persisted trunk (item 2).**
   `setupWorktrees` runs `git worktree add -b <branch> <path>` with no start-point
   (worktrees.mjs:84), so seat branches fork from the root's CURRENT HEAD, not the
   persisted trunk. On a repo checked out on `feature` with trunk `master`, seats
   base on `feature`. Item 2's acceptance requires EVERY trunk touchpoint to use
   the persisted trunk; the worktree-add start-point is one the degraded round
   never checked. Fix: thread the persisted trunk into setupWorktrees and pin the
   start-point (`git worktree add -b <branch> <path> <trunk>`).

2. **[blocking] Gate-artifact verdict header omits the required `harness` field
   (item 4b).** reviews/README.md:26 mandates `harness: <how invoked>`; the
   generated header emits `platform:` instead (loop.mjs:413, pipeline.mjs:272).
   Item 4b acceptance is "layout matches reviews/README.md." Fix: emit `harness`.

3. **[blocking] Child-log cap measures UTF-16 code units, not bytes (item 5).**
   children.mjs:186 gates on `head.length` (UTF-16 units) while maxLogBytes is a
   byte budget; a CJK/emoji transcript writes up to ~3× maxLogBytes to disk. Fix:
   measure `Buffer.byteLength(..., 'utf8')` for the cap decision.

4. **[blocking] Probe cache treats exactly-15-min as stale (item 8).**
   availability.mjs:18 uses strict `< PROBE_CACHE_MS`; the plan says staleness
   `> 15 min` is ignored, so exactly 900000 ms should still be fresh. Fix: `<=`.

5. **[blocking] Detach start-signal is not owner-bound (item 10).**
   detachSupervisor polls `existsSync(lockPath) || fresh state.json` (loop.mjs:270)
   after releasing its own lock; a foreign supervisor that grabs the lock in the
   race window reads as "our child started." Item 10(a) requires proof the DETACHED
   child owns the lock. Fix: bind the start signal to the spawned child's pid (the
   lock records its owner; confirm the recorded owner is the child we forked).

## Non-blocking / already-dispositioned

- N5 (detach supervisor.out runtime cap) and N6 (per-phase budget persistence)
  remain v1.2 deferrals; terra confirmed they are correctly described and did not
  re-raise them as blockers.

## Fold — DONE (commit d8632aa, sole author)

TDD fold, all five findings, hard 5-iteration cap. Fresh-context Opus test-author
wrote one red pin per finding (4 net-new + finding-2 tightened the existing loose
4b assertions), confirmed RED; then implemented green:

1. `setupWorktrees(root, io, trunk)` forks seats from the persisted trunk
   (`git worktree add -b <branch> <path> <trunk>`); pipeline passes `state.trunk`.
2. Both gate-artifact writers emit `harness:` (no stray `platform:` line remains).
3. `children.mjs` caps in UTF-8 bytes via a `clampBytes` Buffer helper.
4. `availability.mjs` freshness boundary is inclusive (`<=`).
5. `detachSupervisor` binds the start-signal to the forked child's lock pid
   (`lockOwnedByChild`), keeping the fast-child fresh-state.json fallback.

Suite 1270/1270, typecheck clean, no shipped contract changed.

## Re-review — PASSED (raiser, iteration 2/5)

final-reviewer-a (codex/gpt-5.6-terra@max) re-reviewed the fold against the actual
fixed code: **all five findings RESOLVED, no fold-induced regression, no new
findings → VERDICT: APPROVED.** Verified typecheck, focused pins, the CJK capture
(11,765 input bytes → 4,053-byte capped log with the verdict tail intact), both
cache boundaries, the fast-child fallback, and sole-author/no-trailer on d8632aa.

## Cross-vendor Gate 2 outcome

| Reviewer | Model | Iter 1 | Iter 2 |
|---|---|---|---|
| final-reviewer-a | codex/gpt-5.6-terra@max | BLOCKED (5) | **APPROVED** |
| final-reviewer-b | claude-code/claude-fable-5 (prior round) | APPROVED_WITH_NOTES | — |

Milestone D is now validated **cross-vendor** (OpenAI + Claude), closing the
degradation caveat from the original degraded round.
