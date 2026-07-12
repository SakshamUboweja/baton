# Test-verifier verdict — gate-2 iteration-2 fold (consolidated)

- **Role**: test-verifier
- **Model**: gpt-5.5 @ xhigh (`codex exec -s read-only`)
- **Harness**: codex CLI, read-only sandbox
- **Date**: 2026-07-12
- **Scope**: `git diff a0e3dcd..HEAD -- tests/` (12 files, ~1090 lines) — the iteration-2 fix wave for findings B1-B6, M1-M8, B5, m1
- **Degraded**: no (single reviewer by design — test-verifier role is single-model)
- **Verdict**: **BLOCKED** — 2 blocking, 3 major

## Findings

1. **[blocking]** `tests/unit/lock-hardening.test.mjs:39` — the B1 "two contenders" test is sequential; the strong check is white-box rm/mkdir instrumentation, so it would not fail on a real double-publish stale-lock race. Fix: barrier-released real-process test, one dead owner + two reclaimers, assert persisted owner/journal proves exactly one takeover.
2. **[blocking]** `tests/commands/majors-minors.test.mjs:185` — B2's failing-hook log path is tested only on a normal tree; a logger writing through a symlinked `.handoff/log` would still pass. Fix: real-fs symlink test for hook-failure logging that asserts fail-open and no write through the linked path.
3. **[major]** `tests/commands/gate2-iter2-group6.test.mjs:129` — M4 low-confidence avoidance assertion is vacuous: the config never requires selecting cursor before an earlier eligible entry. Fix: role chain with cursor first-eligible; assert low-confidence keeps it selectable while high-confidence intake avoids it.
4. **[major]** `tests/commands/gate2-iter2-group6.test.mjs:57` — M2 tests `jailRelPath` but not the Windows `checkHandoffTree` realpath containment. Fix: fake Windows `realpathSync` cases (in-tree, outside-root, cross-volume).
5. **[major]** `tests/integration/receiver-concurrency.test.mjs:83` — M7 races two commits on the *same* prepared receipt, not two independently-prepared receipts from one sealed state. Fix: prepare two distinct receipts, release both from one barrier, assert one wins and loser state is untouched.

## Coverage table

| finding | honest? | test file |
|---|---|---|
| B1 | partial | lock-hardening.test.mjs:18, lock-concurrency.test.mjs:163 |
| B2 | partial | lock-hardening.test.mjs:66, majors-minors.test.mjs:185 |
| B3 | yes | regex-hardening-2.test.mjs:32 |
| B4 | yes | validation-seed.test.mjs:22, :45 |
| B6 | yes | validation-seed.test.mjs:70, majors-minors.test.mjs:87 |
| M1 | yes | checkpoint-pipeline-2.test.mjs:38 |
| M2 | partial | gate2-iter2-group6.test.mjs:48 |
| M3 | yes | gate2-iter2-group6.test.mjs:63, doctor.test.mjs:236, resolve.test.mjs:346 |
| M4 | partial | gate2-iter2-group6.test.mjs:100 |
| M5 | yes | receiver-concurrency.test.mjs:121, checkpoint-pipeline-2.test.mjs:65 |
| M6 | yes | envelopes-2.test.mjs:31, :55 |
| M7 | partial | receiver-concurrency.test.mjs:76 |
| M8 | yes | regex-hardening-2.test.mjs:54 |
| B5 | yes | envelopes-2.test.mjs:97 |
| m1 | yes | checkpoint-pipeline-2.test.mjs:94 |

## Disposition

All 5 findings accepted — each names a test that passes today but would still pass if the fix regressed (hollow/partial coverage) or exercises a weaker path than the real race. Folding all 5 into a strengthening wave; no implementation change implied by any of them except where a strengthened test surfaces a genuine bug.
