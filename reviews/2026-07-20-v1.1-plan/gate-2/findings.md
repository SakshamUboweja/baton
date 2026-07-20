# Gate 2 — Milestone D (v1.1 hardening): collated findings (iteration 1)

Both reviewers APPROVED_WITH_NOTES; no blocking findings; Gate 2 PASSES.
DEGRADED / NON-CROSS-VENDOR this round: the codex account is fully
usage-limited (reset weeks out), so final-reviewer-a ran on fresh-context
Claude Opus instead of codex/gpt-5.6-sol. Both reviewers are therefore
Claude — a real cross-vendor Gate-2 pass should be re-run after codex
resets (reviewer-a caveat 6). Sources: A# = reviewer-a (Opus), B# =
reviewer-b (Fable).

Shared verification: npm test 1264/1264; typecheck clean; commits
09e6264..88b02e0 sole-author SakshamUboweja, zero AI-attribution trailers;
all ten v1.1 items traced to their falsifiable acceptance (not just green);
frozen contracts (exit 0-4, detect 10-14, smk1 token, .handoff layout, hard
5-cap, sole-author) intact; no Milestone A/B regression.

## Findings (deduplicated, all non-blocking)

- **N1 (A1 + B-F4) — detach reports success even if the child never took the
  lock** (loop.mjs detachSupervisor, after the bounded poll). Fix: if the
  lock is still absent after the poll, warn and return non-zero instead of
  printing "detached supervisor started". FOLD NOW (cheap).
- **N2 (A5) — pipeline `--approve-smoke` prints two completion lines**
  (pipeline.mjs: the approval message then the end-of-run done line). Fix:
  return 0 right after the approval message. FOLD NOW (cheap).
- **N3 (A4) — classification re-reads the REDACTED log while the verdict was
  parsed pre-redaction** (loop.mjs classify call vs children.mjs redacted
  write). A secret overlapping a death banner could theoretically shift the
  class. Fix: classify on the same transcript superviseChild already parsed
  (have the runner return it / its class) rather than re-reading the redacted
  file. FOLD NOW (small, real correctness).
- **N4 (B-F2) — dead `capLog`** (children.mjs) — exported/tested but unused
  after the streaming rewrite. Fix: drop it (and its unit test) or route the
  transcript assembly through it. FOLD NOW (cheap; drop).
- **N5 (B-F1 + A3) — supervisor.out byte cap is nominal** (bin spawnDetached
  ignores spec.maxBytes; truncates only on next open, so bounded ACROSS runs
  but not WITHIN one runaway run). Reviewer-b [major], reviewer-a [minor];
  both non-blocking. Item-10 acceptance 10e ("respects its cap") is met
  on-open/across-runs but not at runtime. DEFER to v1.2 (a hard live cap needs
  the detached child to self-cap its own stdout — a wrapper design, not a
  one-liner). Documented in the plan's Deferred section + CHANGELOG caveat.
- **N6 (B-F3 + A2) — per-phase child budget is in-memory** (loop.mjs
  phaseChildren) — a resume refunds it (the hard 5-iteration cap is
  persisted and unaffected). DEFER to v1.2: persist per-phase counts if
  cross-restart runaway protection is wanted; otherwise documented as
  per-invocation.

## Disposition
Fold N1-N4 now via the TDD flow (test-author pins → fresh-Opus verifier,
codex being down → implement → commit). Record N5, N6 as v1.2 deferrals in
docs/plans/2026-07-20-v1.1-hardening.md and a CHANGELOG caveat. Re-review by
each raiser after the fold (fresh Claude subagents; cap 5). Then GATE-STATUS
+ close.
