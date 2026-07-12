# Gate-2 — final status

**PASSED (APPROVED_WITH_NOTES)** on 2026-07-12 at HEAD a16cf0d.

## Path to closure

Gate-2 ran 5 dual-review iterations (Saksham's cap). Iteration 5 was a SPLIT
(reviewer B APPROVED; reviewer A BLOCKED on 3 items), so per the cap the
findings were escalated to Saksham, who chose to fix all three past the cap and
run a targeted re-review.

- **A1** (blocking) checkpoint refresh-vs-takeover TOCTOU → fixed (git captured
  before the lock; reload-modify-write under one fence). **Closed** by reviewer A
  (targeted) and reviewer B (targeted).
- **A2** (major) finalize multi-lock seal → fixed (one lock spanning
  reload→seal→rotate). **Closed** by reviewer A and reviewer B.
- **A3** (major) doctor hook-state semantics → fixed in two passes (enabled keys
  on the actual `baton checkpoint` command field; observed bound to
  `payload.trigger === checkpointEvent`, the per-turn Stop canary). **Closed** by
  reviewer A (A3-reverify: APPROVED) and reviewer B.

## Final verdicts

| reviewer | verdict | A1 | A2 | A3 |
|---|---|---|---|---|
| A (gpt-5.6-sol xhigh) | APPROVED (targeted + A3-reverify) | closed | closed | closed |
| B (claude-fable-5 xhigh, fresh) | APPROVED_WITH_NOTES | closed | closed | closed |

Acceptance constraint 7 (both reviewers APPROVED/APPROVED_WITH_NOTES, notes
folded) is satisfied.

## Outstanding note (dispositioned)

- **[low] checkpoint.mjs seed/adoption/takeover unlocked read-modify-write**
  (reviewer B, targeted finding 1). Pre-existing; a SYNC sub-millisecond window
  (not the async straddle A1 fixed), on rare paths (first-ever seed; explicit
  `--take-over`; first-session adoption), and largely reconciled by the
  A1-fixed final locked rewrite (which reloads and re-materialises from the
  journal). Dispositioned as a **v1.1 hardening item**: fold each into a locked
  reload-modify-write like A1. Logged here; not a v1 blocker.

## Remaining before v1 ships

1. Live cross-harness smoke test on Saksham's machine (Claude Code↔Codex, one
   Cursor direction) — the one acceptance step that cannot run headlessly.
2. Rollout: `baton init` on a second repo; enable GitHub "Include private
   contributions".
