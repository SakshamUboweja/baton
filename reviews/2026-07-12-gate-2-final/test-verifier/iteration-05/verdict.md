# Test-verifier verdict — gate-2 iteration-3 fold (re-verification)

- **Role**: test-verifier
- **Model**: gpt-5.5 @ xhigh (`codex exec -C <repo> -s read-only`)
- **Harness**: codex CLI, read-only sandbox
- **Date**: 2026-07-12
- **Scope**: `git diff e4acd79..HEAD -- tests/ core/ adapters/` (9 test files, ~410 lines — the iteration-3 fold of the 12 collated findings)
- **Degraded**: no
- **Verdict**: **BLOCKED** — 1 blocking, 2 major, 1 minor
- **Iteration**: 5 of 5 (test-verifier gate cap reached)

## Findings (all are test-REGRESSION-COVERAGE gaps; every one of the 12 fixes is confirmed in place)

1. **[blocking]** `tests/integration/lock-concurrency.test.mjs:206` — the F2 seq-uniqueness assertion is hollow for the described under-lock collision: the reclaimers' critical sections write only `order.txt`, never a real journal event, so the OLD takeover-note-before-lock code could still pass (one note, unique seqs). Fix: make the reclaim race include a real competing journal append/checkpoint, or a deterministic white-box interleaving that fails when a takeover/recovery note allocates seq outside a held lock.
2. **[major]** `tests/unit/pathnorm-windows.test.mjs:28` — F9 tests the shared `isContained` helper but not `cmdCheckpoint`'s transcript-containment caller, so reverting `checkpoint.mjs` to the raw `startsWith` compare would not fail. Fix: a `cmdCheckpoint` PreCompact test with Windows backslash `realpathSync` values (in-tree captures, cross-volume/outside refused).
3. **[major]** `tests/commands/gate2-iter3-group6.test.mjs:78` — F12 proves hostile-origin relabeling but not the new pre-read `checkHandoffTree` guard for SessionStart. Fix: a symlinked/escaped `.handoff` SessionStart test emitting no context and not reading through the unsafe tree.
4. **[minor]** `tests/unit/resolve.test.mjs:31` — the resolver contract-header comment still says `capability==='installed'` skips, contradicting the (faithful) updated F1 test. Fix: update the comment.

## Per-finding table

| finding | pinned honestly | would-fail-on-regression |
|---|---|---|
| F1 | yes (updated pin faithful) | yes |
| F2 | partial (at-most-one faithful; collision not pinned) | no |
| F3 | yes | yes |
| F4 | yes | yes |
| F6 | yes | yes |
| F7 | yes | yes |
| F8 | yes | yes |
| F9 | partial (helper covered; checkpoint caller not) | no |
| F10 | yes | yes |
| F11 | yes | yes |
| F12 | partial (relabel covered; jail-before-read not) | no |

## Disposition

This is the **5th** test-verifier iteration for the gate-2 fix work — the iteration cap.
Per Saksham's rule (AGENTS.md §5: "a gate loops at most 5 iterations — hard stop after
the 5th; escalate outstanding findings to Saksham"), the gate ENDS here rather than
running a 6th verification. The verifier confirmed **all 12 implementation fixes are in
place and correct** (8 tests fully pin their fix; the 3 partials + 1 comment are
regression-coverage strengthening, not implementation defects). Outstanding findings
escalated to Saksham for a decision on whether to fold the coverage additions before /
alongside Gate-2 iteration 4.
