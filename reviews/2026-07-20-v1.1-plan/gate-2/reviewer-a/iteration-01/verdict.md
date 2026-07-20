role: final-reviewer-a
model: claude-code/claude-opus-4-8 (fresh-context)
harness: claude-code (Agent tool, fresh context)
date: 2026-07-20
iteration: 1/5
degraded: codex-unavailable, fresh-context-claude-opus
verdict: APPROVED_WITH_NOTES

# Gate 2 — Milestone D (v1.1 hardening) — final review A

## Degradation caveat

final-reviewer-a is normally codex/gpt-5.6-sol. The codex/ChatGPT account is fully
usage-limited (reset weeks out), so codex cannot run. This review is the
fresh-context Claude (Opus) fallback. **Gate 2 is NOT cross-vendor this round** —
both reviewer seats are Claude-family. A real cross-vendor pass should be re-run
after codex resets before treating Milestone D as vendor-independently validated.

## Validation evidence (this session)

- `npm test` → **tests 1264 / pass 1264 / fail 0** (suites 392, duration ~9.4s).
- `npm run typecheck` (`tsc --noEmit`) → **clean**, no output.
- `git log 09e6264..HEAD` → 20 commits, **sole author `SakshamUboweja <ssakshamu@gmail.com>`**
  on every commit; no `Co-Authored-By`, no "Generated with", no AI-attribution
  trailer anywhere in the range (the only "claude" substring is the commit
  subject "…degraded-claude", not a trailer).
- Working tree clean after all test runs (`git status --short` empty) — no
  non-review file modified by this review.

## Per-item verification (against the plan's falsifiable acceptance)

**Item 1 — D9 done-status persistence. VERIFIED.**
`applyLoopEvent` SMOKE_APPROVE sets `DONE` when `phaseIndex >= phaseCount`
(state.mjs:114-124); the non-smoke final phase reaches DONE via PHASE_ADVANCE
(state.mjs:81-85). Test loop-run.test.mjs:377-391 reads the **raw** `state.json`
and asserts `status === 'done'`; the GUARD (393-409) re-runs a done run: prints
done, exit 0, zero re-spawn. Pipeline mirror pinned at pipeline-run.test.mjs:1369-1380.

**Item 2 — Trunk derivation. VERIFIED.**
`deriveTrunk` (pipeline.mjs:100-110): `git symbolic-ref refs/remotes/origin/HEAD`
→ fallback `rev-parse --abbrev-ref HEAD` → `'main'` only if detached. Stamped
once into `state.trunk` at init (pipeline.mjs:197), reused on resume, and
additively migrated for a stamped-but-trunkless legacy state (pipeline.mjs:213-216,
never a refusal). All touchpoints thread the persisted trunk: postflight
(pipeline.mjs:631), merge/attribution scan (worktrees.mjs:141,169-178,197),
already-merged recognizer + stale-park + reviewer/merger prompts
(pipeline.mjs:459,466,471,636,652,682). Residual `'main'` occurrences are
fallback defaults only (worktrees.mjs:121,141,170; pipeline.mjs:109). Tests
trunk-1..trunk-5 (pipeline-run.test.mjs:1767+) pin a master-trunk run end-to-end
including "no 'main' in any git argv"; the main-trunk suite still passes.

**Item 3 — Per-phase child budgets. VERIFIED.**
`phaseChildren` Map gates per phase-id (loop.mjs:367,500-505,534). Test item-3
RED (loop-run.test.mjs:429-450) proves a single phase parks at its own 2-child
budget (global product 6 not exhausted, reason names the phase); GUARD (452-470)
proves the cross-phase SUM (6) legitimately exceeds one budget. See minor note 2.

**Item 4 — Findings persistence. VERIFIED.**
Append-only `.handoff/loop/findings/<gate>.ndjson`; `latestFindings` returns the
last non-empty line (loop.mjs:371-385 / pipeline.mjs:242-256), `persistFindings`
appends (loop.mjs:387-390). Prompts embed the latest findings (loop.mjs:525,
pipeline.mjs:574); escalations fall back to persisted findings
(pipeline.mjs:298-311). Tests 4a-4d (loop-run.test.mjs:479-578) cover
park→resume, crash→re-invoke carrying the LATEST (older superseded), escalation
embedding, and append-only ordering, for both loop and pipeline.

**Item 4b — Review artifacts from gate children. VERIFIED.**
`writeGateArtifacts` (loop, /gate/ phases only, loop.mjs:394-417,601-603) and
`writeGateArtifact` (pipeline, per writer/reviewer/merger sharing one cycle NN,
pipeline.mjs:266-288). Both fail-open with a stderr warning (never fail the run).
Header matches reviews/README.md. Tests: fail-open (loop-run.test.mjs:642-659),
dead/failover child writes NO verdict.md (660-679).

**Item 5 — Streaming log caps. VERIFIED (with minor note 3 on the detached case).**
`superviseChild` streams to a bounded head+tail buffer during capture
(children.mjs:193-214): head frozen at `half`, tail rolls to `half`, so retained
memory is ~maxLogBytes + one chunk regardless of child output volume. The write
goes through the injectable `opts.fs` seam so a recording fake can byte-count.

**Item 6 — Child-log redaction + purge. VERIFIED.**
The capped log write is routed through `redactSecrets` (children.mjs:241) — clean
text passes byte-identical. `purge-transcript` walks the whole `.handoff/` tree
including `.handoff/loop/children/*.log` via `scrubTextFile` (purge-transcript.mjs:
92-96,143) and scrubs the `findings` field of loop ndjson (77-78). Covered by
purge-transcript.test.mjs (green).

**Item 7 — Live codex marker fixture. VERIFIED.**
`tests/fixtures/codex-live-child.transcript.txt` is a real attempt-3 dogfood
transcript containing a **decoy** `VERDICT: BLOCKED` before the `tokens used`
marker (lines 210-211) and the genuine `VERDICT: APPROVED_WITH_NOTES` after it
(258-261). Pinned in loop-children.test.mjs:373-388 — parseVerdict correctly
scans only the region after the LAST `tokens used` line.

**Item 8 — Probe-aware resolution. VERIFIED.**
`readProbeCache` enforces the 15-min freshness window and null-on-stale/absent
(availability.mjs). `resolveRoles` skips `rate-limited`, skips `not-installed`,
keeps `installed/ok` selectable-but-degraded (resolve.mjs:20-51). The same cache
is threaded into the first spawn (loop.mjs:355,510) AND every failover relaunch
for writer/reviewer/merger (failover.mjs:54,109,130; pipeline.mjs:173,531-545,
596-610). Tests 8-1 / 8-1-failover / 8-4 (stale+missing = unchanged) / 8-5
(installed/ok degraded, never blocked) at loop-run.test.mjs:680-744.

**Item 9 — Pipeline smoke gate. VERIFIED; the trunk-sha binding is coherent.**
After the last subtask merges (state DONE) with `smoke.cmd` set and no prior
approval, the pipeline runs the command once, SMOKE_AWAITs, and completes only on
a verified token (pipeline.mjs:722-750). Shared token machinery with the loop.
**Design-fact check:** the token's `gitHead` binds to the **trunk sha**
(`await trunkSha()` at issue pipeline.mjs:737 and at verify:344), NOT HEAD — this
is coherent because a pipeline's merge target is the trunk the reviewer signed off
on, so a trunk that moved after review is a detected drift that parks the
approval. Test 9-3 (pipeline-run.test.mjs:1393-1405) proves it: `git.moveMain(...)`
→ approval refused → exit 4 PARKED. Tests 9-1/9-2/9-2b/9-4/9-5 cover
run-once-after-final-merge, approve→done (raw state), bogus-token refusal,
no-smoke→DONE, and smoke+no-phases acceptance.

**Item 10 — --detach (POSIX). VERIFIED; the "parent returns after child owns
lock" contract holds on the happy path (minor note 1 on the failure edge).**
`detachSupervisor` (loop.mjs:248-274): the PARENT does the lock precheck/reclaim
via `acquireSupervisorLock` (refuses a live owner exit 1 with NOTHING forked;
reaps a provably-dead owner's recorded in-flight child groups BEFORE forking),
then `release()`s and forks via `io.spawnDetached`, then **polls (bounded, 100 ×
50ms) until the child's lock file re-appears** before printing pid + tail hint and
returning 0. Because the parent deletes its own lock before the poll, the poll can
only observe the child's (or a competitor's) lock — a caller of the parent never
observes an ownerless run on the happy path. Single-supervisor correctness does
not depend on the parent precheck: it is guaranteed by the child-level atomic
`wx` lock (a concurrent second detach whose child loses the race refuses exit 1
and dies). Windows falls back to attached with a stderr notice (loop.mjs:77,
pipeline.mjs:88). Seam tests 10-1..10-5 (loop-run.test.mjs:759-842) plus the ONE
real-fork integration test (loop-detach.test.mjs) covering supervisor.out
existence/bound and lock release on completion. Acceptance (a)-(e) each mapped to
a test.

## Frozen-contract regression check — NONE found

- Exit codes 0/1/2/3/4 preserved (loop.mjs:113-114, pipeline.mjs:44-45); detect
  codes 10-14 untouched (no change to the detect command; `classifier.mjs` diff
  is purely the **additive** export of `transcriptTail`, the existing `classify`
  mapping unchanged).
- `.handoff/loop` layout unchanged; new files are additive
  (findings/, merges.ndjson, supervisor.out, reviews/<runId>/...).
- Smoke token format frozen: prefix `smk1`, six ordered fields, per-field digest
  (state.mjs:218-240).
- Hard 5-iteration cap intact: `GATE_ITERATION_CAP = 5`, reducer refuses the 6th
  and escalates (state.mjs:37,86-95); pipeline rejects any spec `iterationCap`
  outside 1-5 before spawning (pipeline.mjs:146-149).
- Sole-author / zero-AI-attribution git identity enforced on children
  (children.mjs:22-28) and across the whole commit range.

## Fresh-eyes defect hunt — no v1.1 blockers

Examined crash/recovery (children.ndjson start/retire matching, lock reclaim
pid+startTime pairing, receipt-before-advance), trunk threading, probe resolution,
smoke-drift, and detach paths. Crash-recovery invariants (H3/I1/I2/I5/G4) are
soundly implemented and well-pinned. The items below are v1.2 hardening notes,
none blocking.

---

VERDICT: APPROVED_WITH_NOTES
FINDINGS:
1. [minor] Detach poll reports success even when the child never acquires the lock — loop.mjs:269-273. If the forked child dies or loses the lock race, the bounded 5s poll simply expires and the parent still prints "detached supervisor started (pid X)" and returns 0, so a caller can observe a claimed-started supervisor that actually failed to take ownership. Happy-path contract holds; this is the failure edge. Fix: after the poll, if `lockPath` is still absent, emit a warning and return non-zero (or re-check the child pid is alive) instead of reporting success.
2. [minor] Per-phase child budget is not crash-durable — loop.mjs:367 (`phaseChildren` in-memory Map). Unlike the persisted iteration cap, the per-phase child counter resets on every invocation/resume, so a phase that consumed most of its budget then parked/crashed gets a fresh full budget on resume. Satisfies item-3's acceptance (per-phase isolation) but not durable runaway protection. Fix (v1.2): persist per-phase child counts alongside `iterations` if cross-restart runaway protection is desired.
3. [minor] supervisor.out cap is not actively enforced at runtime — baton.mjs:79-92. `maxBytes` is passed to `spawnDetached` but the file is only truncated to 0 on the NEXT detach (`'w'` open); during a single detached run the OS redirect is unbounded. In practice the supervisor's own console output is small (child logs stream to separate capped files), and the integration test only asserts `<= 2MB`, so acceptance (e) rests on next-open truncation plus inherently-small output rather than a live cap. Fix (v1.2): wrap the detached stdout in a size-guarded stream for a hard runtime cap.
4. [minor] Classification reads the redacted log while the verdict is parsed pre-redaction — loop.mjs:558-559 vs children.mjs:241,245. If a secret pattern ever overlapped a death-banner tail, `redactSecrets` could alter the bytes the supervisor reclassifies and change the failover decision. Very low likelihood (redaction targets secret formats, not banner text). Note for v1.2: classify on the same in-memory transcript `superviseChild` already parsed, rather than re-reading the redacted file.
5. [very-minor] Pipeline `--approve-smoke` double-prints on completion — pipeline.mjs:356 ("smoke approval verified — pipeline complete") then falls through to :372 ("done — N subtask(s) merged"). Cosmetic; return 0 right after the approval message.
6. [caveat, non-code] Gate 2 is single-vendor this round (codex unavailable) — re-run a real cross-vendor final review after codex resets before treating Milestone D as vendor-independently validated.
