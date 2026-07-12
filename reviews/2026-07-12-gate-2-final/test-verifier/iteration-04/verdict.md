# Test-verifier verdict — gate-2 iteration-3 fold (re-verification)

- **Role**: test-verifier
- **Model**: gpt-5.5 @ xhigh (`codex exec -C <repo> -s read-only`)
- **Harness**: codex CLI, read-only sandbox
- **Date**: 2026-07-12
- **Scope**: `git diff 06f64d8..HEAD -- tests/ core/ adapters/` (commit 5126d3e — the iteration-3 fold of the 5 test-verifier findings)
- **Degraded**: no
- **Verdict**: **APPROVED_WITH_NOTES** — 1 minor

## Findings

1. **[minor]** `tests/integration/lock-concurrency.test.mjs:161` — the real-process reclaim race has only a START barrier, so a regressed rm-then-mkdir could still pass on a single run if one child finishes the reclaim before the other observes the stale owner. Fix (folded): add a second test-only synchronization point around stale-owner observation, so both children provably hold the stale owner before either reclaims — and keep `tests/unit/lock-hardening.test.mjs` as the deterministic regression oracle.

## Per-finding table

| finding | pinned honestly? | test | would-fail-on-regression |
|---|---|---|---|
| 1 lock reclaim | yes (unit oracle) + tightened integration | lock-hardening.test.mjs:52/:70, lock-concurrency.test.mjs | unit: deterministic; integration: near-deterministic after fold |
| 2 hook-log jail | yes | hook-log-symlink.test.mjs | yes |
| 3 Windows realpath | yes | gate2-iter2-group6.test.mjs | yes |
| 4 M4 vacuity | yes | gate2-iter2-group6.test.mjs | yes |
| 5 M7 receipts | yes | receiver-concurrency.test.mjs | yes |
| memfs dir rename | yes | memfs.mjs | yes |

## Disposition

APPROVED_WITH_NOTES — gate-clearing. The single minor is folded (observe-dead barrier added to the integration race), with the unit white-box trace test as the deterministic oracle per the verifier's own recommendation. Cleared for Gate-2 dual re-review.
