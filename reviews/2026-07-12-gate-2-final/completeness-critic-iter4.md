# Completeness-critic pass — gate-2 iteration-4 fold

- **Date**: 2026-07-12
- **Method**: 10 parallel adversarial critics (Workflow `iter4-completeness-critic`, high effort) over `2b04a4a..df5efcc` — one per finding I1–I9 plus a cross-cutting sibling-path critic. Each verified the fix covers EVERY affected path and that a test FAILS on revert.
- **Why**: iterations 3 and 4 were blocked by INCOMPLETE folds (F5 dropped entirely; F10/F7 partial). This pass catches that class before spending the last gate iteration.

## Verdicts

| finding | verdict | action |
|---|---|---|
| I1 recoverLock atomic | complete, revert-guarded | none |
| I2 checkpoint stale git | **partial** — SIBLING `finalize.mjs:63` had the same anti-pattern, unfixed + untested | fixed finalize + test |
| I3 new-generation reset | complete, revert-guarded (strong guard at receive-txn:323) | none |
| I4 probe structural | **partial** — REJECTED tests matched `/ov/` which ALSO matches the probe-timeout msg, so reverting the scanner still passed | tightened to structural msg + <500ms timing |
| I5 doctor four-state | complete (codex-only test) | added cursor assertion |
| I6 resolver non-ok degraded | complete, revert-guarded | none |
| I7 takeover-note lock leak | **partial** — no test made the note throw; reverting the try/catch left all tests green | added throwing-note no-leak test |
| I8 isContained POSIX root | complete, revert-guarded | none |
| I9 transcript backslash guard | complete, revert-guarded | none |
| SIBLING (cross-cutting) | flagged the same finalize:63 stale-git sibling | (covered by I2 fix) |

## Outcome

4 gaps closed in commit 572d77f (1 real bug — finalize stale git; 3 hollow/absent
regression guards). All fixes now fail on revert by construction (structural
message + timing bound for I4; doesNotThrow + no-leak for I7; sibling test for I2).
798 tests, 3/3 stable, typecheck clean. Cleared for Gate-2 iteration 5.
