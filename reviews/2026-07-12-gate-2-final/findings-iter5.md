# Gate-2 iteration-5 collated findings (FINAL — 5-iteration cap reached)

**SPLIT verdict.**
- Reviewer A (gpt-5.6-sol xhigh): **BLOCKED** — 1 blocking, 2 major. 7 of 8 iter-4 findings verified closed (only I5 semantics reopened).
- Reviewer B (claude-fable-5 xhigh, fresh): **APPROVED** — zero findings; 18 live scanner/probe experiments; verified all 6 of its iter-4 findings closed. Explicitly examined the checkpoint/finalize snapshot paths and judged them sufficient (did NOT construct the takeover race).

Acceptance constraint 7 requires BOTH reviewers APPROVED/APPROVED_WITH_NOTES, so the gate is not passed. This is iteration 5 — the cap. Per AGENTS.md §5, outstanding findings escalate to Saksham; there is no iteration 6 without his direction.

## Outstanding (reviewer A), independently verified against code:

| # | sev | area | assessment |
|---|-----|------|-----------|
| A1 | blocking | checkpoint.mjs:293-316 — the snapshot rewrite does `loadBundle` (unlocked) → `await gitSnapshot` (yields the event loop) → `writeSnapshot(merged)`. writeSnapshot locks only the WRITE (store.mjs:193), so `merged` is stale by the time it lands; a concurrent `--take-over` during the await is clobbered (origin rolled back, new owner's event lost). | **CONFIRMED real.** Load+write is not one atomic locked span. |
| A2 | major | finalize.mjs:46-80 — loads, then `await gitSnapshot`, then seals + rotates through SEPARATE lock acquisitions; a decision appended during the await lands in the rotated journal but not the sealed bundle. | **CONFIRMED plausible** (same async-straddles-lock shape as A1). |
| A3 | major (I5) | doctor.mjs:89-124 — the four state fields exist but are coarse: any file containing "baton" marks every hook enabled; any platform-sourced journal entry marks observed + enables the ≤1-turn claim even if the Stop hook is absent. | Real refinement: bind `observed` to the Stop canary specifically; parse each expected hook definition. |

## Fix shape (if approved to exceed the cap)

A1/A2: capture git FIRST (async, no lock), then a SINGLE `withLock` spanning reload-inside-lock → apply → `writeSnapshotIn`/`rotateJournalIn` under one fencing token (atomic read-modify-write). A2 additionally folds seal+rotate into that one lock. Deterministic refresh-vs-takeover / append-during-refresh regression tests.
A3: report per-declared-hook state; gate the mechanical-staleness fidelity claim on a Stop-trigger canary, not any platform-sourced entry.

Estimated: ~2 focused implementation commits + tests, then a TARGETED re-review of only these paths.
