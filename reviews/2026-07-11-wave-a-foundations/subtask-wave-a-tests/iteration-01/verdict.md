role: test-verifier
model: gpt-5.5 @ xhigh
harness: codex exec -s read-only (codex-cli 0.144.1)
date: 2026-07-11
verdict: BLOCKED
degraded: none

VERDICT: BLOCKED

FINDINGS:
1. [blocking] — tests/integration/cli-spawn.test.mjs / `cli spawn` — CLI contract coverage is far below `core.md`: an implementation with only `--version`, unknown-command handling, and `status --json` could pass while omitting `checkpoint`, `finalize`, `detect`, `remap`, `receive`, `init`, `doctor`, `purge-transcript`, `recover`, reserved `wrap`, and exit-code mappings `10/11/12/13`. Add spawn tests for command routing/usage and documented exit-code classes plus `wrap` reserved behavior.

2. [blocking] — tests/unit/jsonl.test.mjs / `jsonl.appendEntry + readAllTolerant` — required `seq monotonic` test is missing. A broken implementation can append/read entries while accepting duplicated or decreasing `seq`. Add a test that appending or reading non-monotonic journal entries is rejected or warned per the intended API contract.

3. [major] — tests/unit/fsx.test.mjs / `fsx.atomicWriteJson makes the target visible only after rename` — atomicity is only tested for a previously absent target. A broken implementation that unlinks/truncates an existing file before rename could pass. Add an existing-target case asserting history only ever exposes old content or final content, never missing/partial content, until the rename.

4. [major] — tests/unit/fsx.test.mjs / fsx suite — required Windows rename-retry `EPERM` behavior is missing. Add a fake `renameSync` that throws `EPERM` once or more, then succeeds, and assert retry behavior and final content.

5. [major] — tests/unit/jsonl.test.mjs / `ids.dedupeKey` — tests verify 64 hex chars and order stability, but not that the digest is actually SHA-256 over canonical JSON. A non-SHA deterministic hash could pass. Add a fixed known-vector test for canonical nested input.

6. [minor] — tests/integration/cli-spawn.test.mjs / `status --json with no bundle exits 1...` — stdout purity is close but not exact: `JSON.parse(r.stdout.trim())` allows leading/trailing stdout whitespace. If the contract means byte-exact one envelope, assert `r.stdout === JSON.stringify(parsed) + "\n"` or equivalent agreed formatting, and assert diagnostics stay off stdout.

7. [minor] — tests/helpers/memfs.mjs / `__history` mechanism — sound for proving the fake’s synchronous mutation history: target first appears via `renameSync` and never carries partial content in recorded snapshots. It proves less than real crash/durability atomicity, interprocess visibility, fsync behavior, or existing-target replacement unless those scenarios are explicitly modeled.
