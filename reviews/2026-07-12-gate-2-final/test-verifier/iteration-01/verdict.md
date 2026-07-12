role: test-verifier (consolidated, gate-2 fix wave)
model: gpt-5.5 @ xhigh
harness: codex exec -s read-only (codex-cli 0.144.1)
date: 2026-07-12
verdict: BLOCKED
degraded: none
scope: git diff 373f0c1..HEAD -- tests/ (23 files); coverage audit vs findings 6,8-16

VERDICT: BLOCKED

1. [major] — tests/integration/lock-concurrency.test.mjs:82 — The holder child retries forever and the parent waits on `Promise.all` with no child timeout, so a lock regression can hang the suite instead of failing deterministically. — Bound the retry loop and child lifetime with a timeout/abort path that kills children and fails with captured stderr/state.

2. [major] — tests/unit/redact.test.mjs:29 — The secret-fragment assertion regex misses the bearer-token fixture at tests/unit/redact.test.mjs:16, so a partial redaction could leave that token behind while the test still passes. — Give each planted fixture an explicit forbidden fragment and assert it is absent unconditionally.

3. [minor] — tests/unit/redact.test.mjs:39 — The “non-strings” test only passes an empty string, so it does not prove non-string input handling. — Pass actual non-string values or rename the case to match the exercised contract.

| Finding | Covered honestly? | Test file(s) |
|---|---|---|
| 6 | yes | tests/unit/jail.test.mjs:16; tests/unit/regex-hardening.test.mjs:34; tests/unit/schema-deep.test.mjs:34; tests/unit/merge-hardening.test.mjs:19; tests/integration/symlink-escape.test.mjs:76; tests/helpers/memfs.mjs:183 |
| 8 | yes | tests/adapters/codex-templates.test.mjs:125; tests/adapters/cursor-templates.test.mjs:123; tests/commands/session-start.test.mjs:49; tests/integration/limit-death-chain.test.mjs:30 |
| 9 | yes | tests/templates/templates-contract.test.mjs:65; tests/templates/templates-contract.test.mjs:127 |
| 10 | partial | tests/commands/checkpoint-pipeline.test.mjs:31; tests/commands/checkpoint-pipeline.test.mjs:55; tests/commands/checkpoint-pipeline.test.mjs:105; tests/unit/redact.test.mjs:23, but see finding 2 |
| 11 | yes | tests/commands/envelopes.test.mjs:29; tests/commands/envelopes.test.mjs:54; tests/commands/recover.test.mjs:16 |
| 12 | partial | tests/adapters/claude-code-hook-spawn.test.mjs:44; tests/integration/e2e-failover.test.mjs:128; tests/helpers/fakeio.mjs:83; tests/integration/lock-concurrency.test.mjs:96, but see finding 1 |
| 13 | yes | tests/commands/doctor-gaps.test.mjs:32; tests/commands/doctor-gaps.test.mjs:69; tests/commands/doctor-gaps.test.mjs:112; tests/commands/doctor-gaps.test.mjs:143 |
| 14 | yes | tests/commands/majors-minors.test.mjs:31 |
| 15 | yes | tests/commands/majors-minors.test.mjs:71 |
| 16 | yes | tests/commands/majors-minors.test.mjs:105; tests/commands/majors-minors.test.mjs:121; tests/commands/majors-minors.test.mjs:139; tests/commands/majors-minors.test.mjs:157; tests/commands/majors-minors.test.mjs:177; tests/commands/majors-minors.test.mjs:206 |
