# Gate 2 (CROSS-VENDOR) — Milestone D (v1.1 hardening): PASSED

Date closed: 2026-07-20
Fold commit: d8632aa · suite 1270/1270 green · `tsc --noEmit` clean

## Why this round exists

The original Gate 2 (../gate-2/) ran degraded Claude-only because the codex
account was usage-limited, so it was NOT cross-vendor and found no blockers. Once
codex recovered, this round re-ran the codex arm — the true cross-vendor check —
and it found five real defects the Claude-only round missed. This is the concrete
justification for the plan's cross-vendor-preferred final-review constraint.

## Verdicts

| Reviewer | Model | Iter 1 | Iter 2 |
|---|---|---|---|
| final-reviewer-a | codex/gpt-5.6-terra @ max effort, read-only, fresh context | BLOCKED (5 findings) | APPROVED |
| final-reviewer-b | claude-code/claude-fable-5, fresh context (prior round) | APPROVED_WITH_NOTES | — |

Cross-vendor (OpenAI + Claude), independent, fresh context. Iteration 2 confirmed
all five findings resolved with no fold-induced regression and no new findings.

## The five findings — all folded (TDD, red pins first)

1. item 2 — worktree setup ignored the persisted trunk; seat branches now fork
   from `state.trunk` via `git worktree add -b <branch> <path> <trunk>`.
2. item 4b — gate-artifact verdict header emitted `platform:`; now emits the
   README-mandated `harness:`.
3. item 5 — child-log cap measured UTF-16 code units; now UTF-8 bytes
   (`Buffer.byteLength` + `clampBytes`), so a CJK/emoji log can't ~3× the cap.
4. item 8 — probe-cache freshness boundary was exclusive; now inclusive (`<=`),
   so exactly 15 min reads fresh.
5. item 10 — detach start-signal was not owner-bound; now confirms the
   `supervisor.lock` records the forked child's pid before reporting "started"
   (foreign-lock race no longer reads as success), keeping the fast-child
   fresh-state.json fallback.

## Frozen contracts intact

Exit codes 0–4 / detect 10–14, smk1 token format, `.handoff` layouts (new files
additive), the hard 5-iteration cap, and the sole-author / zero-AI-attribution git
invariant all verified unchanged by both iterations. Fold commit d8632aa is sole
author `SakshamUboweja <ssakshamu@gmail.com>`, no AI-attribution trailer.

## Iteration history

Iter 1: BLOCKED, 5 confirmed findings. Fold: 5 red pins (fresh-context Opus
test-author) → green (d8632aa), full suite 1270/1270 + typecheck clean. Iter 2:
APPROVED, findings none. Gate closed within the 5-iteration cap (2 iterations).

## Milestone D status

Milestone D (v1.1 hardening) is now validated cross-vendor. The plan-tier note
Saksham flagged is moot for review quality this round — terra (a codex model) ran
the cross-vendor arm at max effort and the pass is genuine.
