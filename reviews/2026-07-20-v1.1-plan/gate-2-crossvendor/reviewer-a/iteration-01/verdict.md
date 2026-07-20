role: final-reviewer-a
model: codex/gpt-5.6-terra@max
harness: codex exec -s read-only (background, cross-vendor arm)
date: 2026-07-20
iteration: 1/5
degraded: none (cross-vendor — codex account recovered)
verdict: BLOCKED

# Gate 2 (cross-vendor) — Milestone D (v1.1 hardening) — final review A

## Validation evidence

- `npm test` → 1,266 tests: 1,202 pass, 64 fail. All 64 failures are sandbox-denied `mkdtemp` calls (`EPERM`), so real-filesystem integration coverage could not run here.
- Focused in-memory acceptance pins → 237/237 pass, 0 fail.
- `npm run typecheck` → clean.
- `git rev-list --count 0ee7e99^..HEAD` → 17 commits. Author/committer check found only `SakshamUboweja <ssakshamu@gmail.com>`; no prohibited commit trailers.

## Per-item verdict

- **1 — PASS.** [state.mjs:114](/Users/saksham/baton/core/src/loop/state.mjs:114) persists `done` when approved after the final phase; re-run reaches the done print path without spawning. Focused D9 pins pass.

- **2 — FAIL.** Trunk is persisted ([pipeline.mjs:197](/Users/saksham/baton/core/src/commands/pipeline.mjs:197)), but [setupWorktrees](/Users/saksham/baton/core/src/loop/worktrees.mjs:83) never receives or supplies it to `git worktree add`. A root checked out on `feature` with persisted trunk `master` creates seat branches from `feature`, not `master`; preflight does not detect that base mismatch.

- **3 — PASS.** [loop.mjs:512](/Users/saksham/baton/core/src/commands/loop.mjs:512) gates a per-phase `Map`, names the exhausted phase, and leaves other phases’ counters independent. N6’s cross-invocation reset is the documented v1.2 deferral and is not counted here.

- **4 — PASS.** Both loop and pipeline read the latest append-only finding ([loop.mjs:383](/Users/saksham/baton/core/src/commands/loop.mjs:383), [pipeline.mjs:242](/Users/saksham/baton/core/src/commands/pipeline.mjs:242)), persist before iteration transition, and use persisted findings in escalation.

- **4b — FAIL.** Generated `verdict.md` headers contain `platform:` but omit the required `harness:` field ([loop.mjs:410](/Users/saksham/baton/core/src/commands/loop.mjs:410), [pipeline.mjs:269](/Users/saksham/baton/core/src/commands/pipeline.mjs:269)); [reviews/README.md:21](/Users/saksham/baton/reviews/README.md:21) requires `harness`. The tests relax this by accepting either field.

- **5 — FAIL.** The purported byte cap uses JavaScript string `.length` ([children.mjs:182](/Users/saksham/baton/core/src/loop/children.mjs:182)) before writing UTF-8 text. A read-only check showed 1,000 `漢` code units are 3,000 bytes, so a CJK transcript can exceed `maxLogBytes` roughly 3×.

- **6 — PASS.** Child logs pass through redaction before write ([children.mjs:214](/Users/saksham/baton/core/src/loop/children.mjs:214)); purge walks all of `.handoff` and scrubs `.log` files and findings NDJSON ([purge-transcript.mjs:139](/Users/saksham/baton/core/src/commands/purge-transcript.mjs:139)).

- **7 — PASS.** The committed fixture’s final marker and observed `APPROVED_WITH_NOTES` verdict are present at [codex-live-child.transcript.txt:258](/Users/saksham/baton/tests/fixtures/codex-live-child.transcript.txt:258); focused parser/tail tests pass.

- **8 — FAIL.** [availability.mjs:18](/Users/saksham/baton/core/src/roles/availability.mjs:18) uses `< 15 min`, despite the stated fresh `≤15 min` contract. At exactly 900,000 ms, a rate-limited cache becomes `null`; the read-only probe reproduced that result.

- **9 — PASS.** Pipeline runs smoke only after final merge ([pipeline.mjs:730](/Users/saksham/baton/core/src/commands/pipeline.mjs:730)), shares the token verifier, and approval transitions through the D9-correct `DONE` state.

- **10 — FAIL.** [detachSupervisor](/Users/saksham/baton/core/src/commands/loop.mjs:269) treats any existing lock as proof that the detached child owns it. A read-only in-memory reproduction returned success for spawned PID 9999 while the lock belonged to PID 2222, violating the required ownership handoff.

## Frozen-contract regression check

No separate frozen-contract regression found: detect code is unchanged in the milestone diff; exit mappings, smoke token fields, and hard five-iteration cap remain intact. `.handoff/loop` changes are additive. Child git identity remains fixed at [children.mjs:22](/Users/saksham/baton/core/src/loop/children.mjs:22), and the 17-commit range has sole author/committer identity with no prohibited trailers.

## Fresh-eyes defect hunt

The master-trunk fake does not model the worktree start commit, detach tests make the spawned child write the lock immediately, cap tests use ASCII only, and cache tests skip the exact 15-minute boundary. N1–N4 were folded, but N1’s lock-existence signal is not owner-bound. N5/N6 remain documented v1.2 deferrals and were not raised as blockers.

VERDICT: BLOCKED
FINDINGS: 1. [blocking] Worktree setup ignores persisted trunk. 2. [blocking] Gate artifacts omit required `harness`. 3. [blocking] Child-log cap measures UTF-16 characters, not bytes. 4. [blocking] Exactly-15-minute probe cache is treated stale. 5. [blocking] Detach accepts a foreign lock as child ownership.
