role: plan-reviewer
model: gpt-5.6-sol @ xhigh
harness: codex exec -s read-only (codex-cli 0.144.1)
date: 2026-07-11
verdict: BLOCKED
degraded: none

VERDICT: BLOCKED

FINDINGS:
1. [blocking] — Claude Code adapter — “`Stop` | Primary mechanical checkpoint” misses limit failures: API errors fire `StopFailure` instead, with structured error fields; `Stop` does not run. Thus Tier A cannot detect its defining failure path. Add `StopFailure`, classify its `error`/`error_details`/`last_assistant_message`, checkpoint fail-open, and test every documented error type. [Claude hooks reference](https://code.claude.com/docs/en/hooks#stopfailure).

2. [blocking] — Codex adapter — “no lifecycle hooks exist” and reliance on “`~/.codex/prompts` slash commands” are obsolete assumptions. Current Codex exposes stable lifecycle hooks and plugins, while custom prompts are deprecated. Redesign around a Codex plugin/project hooks and skills; cut the notify shim and prompts from the primary path, retaining prompts only as a documented legacy fallback. [Codex hooks](https://learn.chatgpt.com/docs/hooks), [custom-prompts deprecation](https://learn.chatgpt.com/docs/custom-prompts).

3. [blocking] — Core bundle — “single active bundle” plus “append-only events” has no locking or compare-and-swap protocol. Two sessions can interleave journal writes, overwrite snapshots, reuse sequence numbers, or receive the same bundle. Add a repo-scoped lock/lease, writer/session IDs, monotonic sequence allocation, stale-lock recovery, and concurrency/process-kill tests. Multi-bundle UI can remain v2.

4. [major] — Build order — “full module APIs, per-module test lists…specified in the core design” references material absent from this plan, preventing dependency review. The sequence also builds `checkpoint cmd` before `git snapshot`, although checkpoints require git state, and claims dogfooded templates “from day one” while implementing templates near the end. Incorporate the missing design, move git snapshot before checkpoint, and establish templates/scaffold once rather than twice.

5. [major] — Core/Receive — “persists a `roles.remap` journal event” occurs before successful acknowledgement, while only Claude’s adapter “flips bundle to `received`.” Cancellation, unavailable roles, or concurrent receivers leave partial state. Make receive a core-owned prepare/commit transaction with a receipt token, atomic state transition, retry semantics, and identical behavior across adapters.

6. [major] — Sandbox and repository assumptions — “mechanical git state is always re-derived” assumes a writable git worktree. Read-only harness sandboxes cannot write `.handoff/`; non-git directories, nested monorepo launches, linked worktrees, and multiple roots are undefined. Specify root discovery and precedence, graceful non-git mode, permission-denied behavior, and a user-executed fallback when agent writes are unavailable.

7. [major] — Bundle/recovery — “append-only journal” has no rotation or size bound, yet full recovery replays it forever. Frequent hooks make startup and rebuild increasingly expensive, and concurrent compaction is unspecified. Add journal checkpoints/rotation at finalize, retention limits, crash-safe rotation ordering, and large-journal performance tests.

8. [major] — Limit detector — “signatures…WILL drift” is addressed only with positive verbatim fixtures. False positives could incorrectly avoid a platform; arbitrary overlay regexes can also cause pathological matching. Add negative/near-miss, ANSI, localized, malformed-JSON, multiline, precedence, timeout, and regex-safety tests. Prefer structured harness error types when available and use text signatures only as fallback.

9. [major] — PreCompact/security — “Snapshot transcript tail” is absent from the bundle schema and lacks redaction, consent, or size rules. Transcript tails can contain credentials or unrelated private text. Either cut transcript capture from v1 or define an opt-in, bounded, redacted field with secret fixtures and deletion behavior.

10. [minor] — Process/attribution — “Gate 1 already passed for this plan” prejudges this review. Separately, “exactly one author” is incompatible with normal future open-source contributions if permanent. Remove the pre-passed claim and scope sole-author enforcement to initial repository construction; retain the no-AI-attribution rule independently.

MISSING:

- Supported harness/CLI version ranges and compatibility policy.
- Six directional handoff contract tests, not only Claude↔Codex.
- npm `pack`/fresh-install/bin/shebang tests on Linux, macOS, and Windows.
- Git timeout behavior for very large repositories.
- Role-availability probe definition, caching, and offline behavior.
- Threat model for symlinks, malicious bundle/config content, and path traversal.
