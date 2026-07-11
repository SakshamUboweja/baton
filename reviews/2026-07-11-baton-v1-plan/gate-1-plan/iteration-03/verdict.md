role: plan-reviewer
model: gpt-5.6-sol @ xhigh
harness: codex exec -s read-only (codex-cli 0.144.1)
date: 2026-07-11
verdict: BLOCKED
degraded: none

VERDICT: BLOCKED

FINDINGS: Prior-finding audit: StopFailure adoption; Codex lifecycle hooks, prompt demotion, notify-shim removal and trust states; Cursor events; receive prepare/commit and open→received handling; foreign-session rejection; fencing tokens; build order; root/sandbox degradation; journal rotation; detector hardening; transcript policy and whole-tree purge; claim/sole-author wording; compatibility; threat model; six-direction tests; packaging CI; git timeouts; and availability probing are all substantively dispositioned. They are not re-raised below except where the revised mechanism introduces a new defect.

1. [blocking] — Core engine / Concurrency — “re-verifies the holder’s token immediately before acting” does not close the check-then-write race: a writer can verify, pause, be replaced after 60 seconds, then resume and mutate state after the new owner acquires the lock. Fencing tokens alone cannot make filesystem writes conditional. — Do not steal merely by heartbeat age. Record host plus process-instance identity and auto-recover only when the owner is provably dead; otherwise require explicit forced recovery. Add a test pausing the owner after its final token check, not merely before it.

2. [blocking] — Concurrency + Receive — `receive --commit` changes `open|sealed → received`, but no transition transfers active ownership to the receiving session or reopens a writable generation. The next platform’s checkpoints therefore conflict with the foreign-session rule, and a subsequent failover has no receivable `open`/`sealed` state. — Atomically adopt the receiving platform/session at commit and create an active `open` generation while retaining the prior receipt/seal in history. Add A→B→C chained-failover tests, including checkpoints immediately after each receive.

3. [major] — Concurrency / Receive — “returns a one-time receipt token … without mutating state” does not specify what the token binds. A checkpoint, config edit, HEAD change, or availability-cache change between prepare and commit could make the emitted prompt and remap stale. — Bind the token to bundle revision/journal sequence, normalized intake, config digest, target session, and relevant probe snapshot; commit must reject drift and require re-prepare. Test checkpoint/config races as well as competing receivers.

4. [major] — Transcript policy + CLI surface + Build order — `baton purge-transcript` is promised and treated as the privacy remedy, but it is absent from the “frozen” CLI command list and has no explicit implementation commit. — Add it to the CLI contract and build sequence, including packaged-bin, interruption-recovery, and complete-tree tests.

5. [major] — Limit detector — “structured signals first … codex exec exit codes” is underspecified and risks treating a generic nonzero Codex exit as a usage limit. Nonzero can represent many failures. — Define that only a documented, limit-specific structured field may produce exit 10; generic nonzero must be combined with JSON/text evidence or classify as `other-error`. Add non-limit failing-process fixtures.

6. [minor] — Role matrix / Availability probing — “five states” mixes capability milestones (`installed`, `authenticated`, `reachable`) with outcomes (`rate-limited`, `unknown`) without defining exclusivity or resolver eligibility. — Specify an ordered state machine or separate boolean dimensions, and define which combinations are selectable or degraded.

MISSING:

- Explicit support boundary for local filesystems versus network/shared filesystems.
- Crash-recovery rules for incomplete history rotation, forced takeover, and interrupted transcript purge.
- Contract tests for chained failovers, prepare-versus-checkpoint races, and a stale owner paused after its final fence check.
