# Gate 2 — Milestone D (v1.1 hardening): PASSED

Date closed: 2026-07-20
Final commit: 5e72dd2 · suite 1266/1266 green · `tsc --noEmit` clean

## Verdicts

| Reviewer | Model (actual) | Verdict |
|---|---|---|
| final-reviewer-a | claude-code/claude-opus-4-8, fresh context (`degraded: codex-unavailable` — normally codex/gpt-5.6-sol) | APPROVED_WITH_NOTES |
| final-reviewer-b | claude-code/claude-fable-5, fresh context | APPROVED_WITH_NOTES |

Both independent, fresh-context, single iteration. No blocking findings.

## DEGRADATION — not cross-vendor this round

The codex/ChatGPT account is fully usage-limited (reset weeks out), so
final-reviewer-a could not run on codex and fell back to fresh-context Claude
Opus per the config chain. **Both Gate-2 reviewers are therefore Claude — this
pass is NOT cross-vendor.** It is a legitimate dual fresh-context review, but a
real cross-vendor Gate-2 pass (codex reviewer-a) should be re-run once the
codex account recovers. The same outage forced the v1.1 test-verifier series
and the live dogfood worker chains onto Claude (documented in the fold
findings and the dogfood config's `_degraded` key).

## The ten v1.1 items — all shipped

1 D9 done-status persistence (0ee7e99) · 2 trunk derivation (6aced04) ·
3 per-phase child budgets + 4 findings persistence (db13a92) ·
4b review artifacts + 5 streaming log caps (3d85fae) ·
6 child-log redaction + purge (036a823) · 7 live codex fixture (cb05124) ·
8 probe-aware resolution (0213eeb) · 9 pipeline smoke gate + 10 --detach (88b02e0).

Each traced to its falsifiable acceptance by both reviewers (not just
test-passing). Frozen contracts intact: exit codes 0–4 / detect 10–14, smk1
token format, `.handoff` layouts, hard 5-iteration cap, sole-author /
zero-AI-attribution git invariant.

## Live verification

A fresh-clone pipeline dogfood (~/baton-dogfood-4, degraded Claude-only roles)
ran both real doc subtasks end-to-end to DONE: merges + receipts +
sole-author commits, and item-4b review artifacts written live under
`reviews/<runId>/`. The produced CHANGELOG.md + README resume subsection were
cherry-picked into the repo (cf700f6, fe5a3c9).

## Gate-2 notes disposition

Folded (5e72dd2, verifier-approved pins):
- N1 — `--detach` returns non-zero + warns when the child never starts
  (durable start-signal: lock held OR fresh state.json), no phantom "started".
- N2 — pipeline `--approve-smoke` prints a single completion line.
- N3 — classification uses the pre-redaction parsed transcript, not a re-read
  of the redacted log (a secret over a death banner can't shift the class).
- N4 — dead `capLog` export dropped.

Deferred to v1.2 (recorded in docs/plans/2026-07-20-v1.1-hardening.md):
- N5 — `--detach` supervisor.out runtime byte cap (bounded on-open only today).
- N6 — per-phase child budget persistence across resume (hard 5-cap unaffected).

## Iteration history

Gate-1 plan APPROVED at iteration 2 (0291e22). Build: 5 verifier-gated pin
series (items 1-2, 3-4, 4b-5, 6-7, 8, 9-10), each APPROVED within its cap.
Gate 2: one iteration, both reviewers APPROVED_WITH_NOTES, notes folded.
