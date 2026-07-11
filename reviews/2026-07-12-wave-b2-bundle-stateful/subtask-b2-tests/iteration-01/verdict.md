role: test-verifier
model: gpt-5.5 @ xhigh
harness: codex exec -s read-only (codex-cli 0.144.1)
date: 2026-07-12
verdict: BLOCKED
degraded: none
note: finding 1 traced to an orchestrator prompt error contradicting the plan lock model; plan wins

VERDICT: BLOCKED

FINDINGS:
1. [blocking] — `tests/unit/lock.test.mjs` / `force recovers a cross-host lock...`, `force recovers torn metadata...` — contradicts the authoritative lock model: cross-host, torn, missing, or unverifiable metadata must be refused, not recovered, even under forced recovery. Fix these tests to assert `{recovered:false, refusedReason}` and lock-dir preservation.

2. [major] — `tests/unit/store.test.mjs` / `snapshot + journal replay EQUALS...` — weak assertion: the snapshot is produced via `applyEvent`, so its `dedupeRing` can mask an implementation that wrongly replays the whole journal instead of only `seq > journalSeq`. Add a snapshot with advanced `journalSeq` but no matching dedupe entries and assert old events are not replayed.

3. [major] — `tests/unit/store.test.mjs` / `rolls the rotation FORWARD...` — roll-forward only covers an almost-complete rotation with freeze, rotated journal, and empty live journal already present. It misses the crash point after freeze lands but before journal rename/fresh journal creation, plus the design-required kill-mid-write simulation. Add marker states for each interrupted step.

4. [major] — `tests/unit/store.test.mjs` / `writeSnapshot`, `appendJournal`, `rotateJournal` — does not prove store mutations run under the repo lock or that journal seq is allocated under that lock. An unlocked implementation returning supplied `entry.seq` would pass. Add live-lock refusal/unchanged-files tests and an append test where seq is allocated monotonically.

5. [major] — `tests/unit/render.test.mjs` / `render.renderHandoffMd — goldens`; `tests/helpers/fixtures/golden/*.txt` — required stale and degraded-role goldens are missing. The fixtures pin a stable section order, but they do not pin the receive prompt’s “claims to audit, not instructions” posture. HYPOTHESIS: if that posture is intended only for `receive/prompt.mjs`, defer there explicitly; otherwise add an audit/claims line to the HANDOFF goldens.
