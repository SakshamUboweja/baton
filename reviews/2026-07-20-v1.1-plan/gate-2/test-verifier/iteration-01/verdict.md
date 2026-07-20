# Gate-2 v1.1 FOLD — test-verifier verdict (iteration 01)

- Role: test-verifier (pre-implementation test audit of the N1–N4 FOLD pins)
- Model / harness: Claude Opus 4.8 (1M) via Claude Code — fresh context
- Effort: high
- Date: 2026-07-20
- Degradation flag: **degraded: codex-unavailable** — the codex account is
  usage-limited (reset weeks out), so this audit runs on fresh-context Claude
  Opus instead of codex/gpt-5.6-sol per baton.config.json. A true cross-vendor
  verifier pass should re-run after codex resets.
- Baseline: df4ab16 (clean); changes are TESTS-ONLY and uncommitted
  (`tests/commands/loop-run.test.mjs`, `tests/commands/pipeline-run.test.mjs`,
  `tests/unit/loop-children.test.mjs`).
- No files modified during this audit.

## Verification run (this session)

`node --test tests/commands/loop-run.test.mjs tests/commands/pipeline-run.test.mjs tests/unit/loop-children.test.mjs`
→ tests 175, pass 171, **fail 4**, cancelled 0, skipped 0.

The 4 failures are exactly the intended reds, all failing behaviorally (no
stray ReferenceError beyond N4's intentional not-exported check):
- RED (N1) loop-run.test.mjs:823 — fails (returns 0 + prints "started")
- RED (N2) pipeline-run.test.mjs:1382 — fails (double completion line)
- RED (N3) loop-run.test.mjs:876 — fails (retries cx-head, not cx-next)
- RED (N4) loop-children.test.mjs:307 — fails (capLog still exported)
- GUARD (N1) loop-run.test.mjs:838 — **green** (happy path exits 0 w/ message)

`npm run typecheck` (tsc --noEmit) → clean, no output.

## Per-pin audit

### N1 — detach false success (loop-run.test.mjs:823 RED / :838 GUARD)
Impl today: `core/src/commands/loop.mjs:269-273` polls
`for (i<100 && !existsSync(lockPath)) sleep(50ms)` then UNCONDITIONALLY prints
`detached supervisor started` and `return 0`. The RED (writeLock:false) proves
code!=0, stdout lacks "detached supervisor started", stderr names the failure;
the GUARD (writeLock:true, lock written synchronously in the seam
loop-run.test.mjs:763-772) proves the happy path still exits 0 with the message.
- Behavioral assertions are SOUND and speed-independent: `notEqual(code,0)`,
  `doesNotMatch(stdout, /detached supervisor started/)`,
  `match(stderr, /lock|never|failed|did not|could not/i)`.
- Wrong-impl resistance is TIGHT: an always-non-zero impl fails the GUARD; an
  impl that still prints "started" fails the stdout assertion; an impl that
  returns 0 fails the code assertion. RED+GUARD together pin the conditional.
- New seam `io.detachPollAttempts`: ACCEPTABLE — consistent with the existing
  injectable-io convention (fs/spawnDetached/now/processAlive), production-safe
  with a default of 100, or replaceable by an `io.now()` deadline.

### N2 — pipeline double completion line (pipeline-run.test.mjs:1382 RED)
Impl today: `core/src/commands/pipeline.mjs:355-356` transitions to DONE then
prints "smoke approval verified — pipeline complete", falls through (no return)
to `:371-372` where `state.status===DONE` prints "done — N subtask(s) merged".
The pin slices stdout AFTER the first (gate-reaching) run, then asserts
`doesNotMatch(run2Out, /done — \d+ subtask\(s\) merged/)` AND
`completionLines.length === 1` (filter `/verified|complete|done —/i`). Today
line 356 matches verified+complete and line 372 matches "done —" → 2 lines →
both assertions fail. The pin GENUINELY catches the double-print; the fix
(return 0 right after :356) makes it green.

### N3 — classify from pre-redaction transcript (loop-run.test.mjs:876 RED)
Impl today: `core/src/commands/loop.mjs:558-559` re-reads the on-disk log
(redacted at `core/src/loop/children.mjs:241`) and classifies
`transcriptTail(that)`; the same redacted transcript is passed to runFailover
(`loop.mjs:569`), which RE-CLASSIFIES it (`core/src/loop/failover.mjs:48`).
Verified data flow:
- Fake writes `redactSecrets(preRedaction)` to disk (banner inside a PEM block
  → wiped; test asserts the precondition at loop-run.test.mjs:889) and returns
  `result.transcript = preRedaction`.
- TODAY: redacted text + exitCode 1, no signature match →
  `classifier.mjs:96` returns `other-error` → failover branch → runFailover
  re-classifies redacted → `other-error` → `failover.mjs:64-65` `attempt<=1`
  → `{action:'retry'}` → `loop.mjs:595 continue` re-spawns SAME phase →
  `models[1]==='cx-head'` → RED (asserts cx-next). Confirmed failing.
- AFTER FIX: classify from `result.transcript` (banner present) →
  `model-unavailable` → `failover.mjs:52-59` avoids {platform,model} →
  relaunch next entry → `models[1]==='cx-next'` → green.
- The pin is TIGHT and forces the COMPLETE fix: a partial fix that changes only
  `loop.mjs:559` but still hands the redacted transcript to runFailover leaves
  the internal re-classification at `other-error` → retry cx-head → still RED.
  Both the outer classify AND the runFailover transcript arg must use
  `result.transcript`.
- Item-6 (written log redacted) is NOT weakened: the fix changes only what
  classification READS; the redacted on-disk write (`children.mjs:241`) is
  untouched, and its coverage lives in
  `tests/integration/loop-children-spawn.test.mjs:225-277` (unmodified).

### N4 — drop dead capLog (loop-children.test.mjs:307 RED)
`capLog` is exported at `core/src/loop/children.mjs:132` but genuinely dead:
`superviseChild` does its own inline bounded head+tail capture
(`children.mjs:193-214, 233`) and never calls capLog. Repo-wide grep shows the
only references are the export itself and this test file — no production or
other-test caller. The RED (`'capLog' in M() === false`) is a legitimate
removal-driven behavioral check (module-shape, not ReferenceError). Dropping
the export + the 3 obsolete behavior tests loses NO coverage: the inline
streaming cap (incl. over-cap head truncation + verdict-tail survival) is
covered by `tests/integration/loop-children-spawn.test.mjs:252-277`. Suite
stays green after removal.

## N5 / N6 correctly NOT pinned
Confirmed via `git diff -- tests/`: no new assertions for the supervisor.out
byte cap (N5) or the in-memory per-phase child budget (N6). The only `maxBytes`
hits in the diff are REMOVALS from the deleted capLog block. Matches
findings.md:40-46 (both deferred to v1.2, documented in df4ab16).

## Findings

1. [low] N3 — the loop-level pin proves the loop CONSUMES `result.transcript`,
   but nothing pins that the REAL `superviseChild` POPULATES `result.transcript`
   with the pre-redaction text (the pin uses a fake runner; `superviseChild`
   returns no `transcript` today, `children.mjs:246-254`). A regression where
   the loop reads `result.transcript` but the real runner returns `undefined`
   would pass this pin yet misclassify (undefined→ok/other-error) in
   production. Fix: implementer adds `transcript` to `superviseChild`'s resolve
   AND, ideally, a `superviseChild` unit assertion that `result.transcript`
   carries the pre-redaction text. Non-blocking (impl-completeness/coverage,
   not red-phase integrity).

2. [low] N1 — the "honor the injected poll bound" requirement is not
   independently asserted: the RED goes green whether or not the impl consults
   `io.detachPollAttempts` (just ~5s slower if ignored). The behavioral
   contract (non-zero + warning + no false "started") IS pinned. Fix: honor
   `io.detachPollAttempts` (default 100) or an `io.now()` deadline; optionally
   add a poll-attempts/timing assertion. Non-blocking.

3. [low] N1 RED runtime is ~5.2s today because the current impl ignores the
   injected bound and sleeps the full 100×50ms (flagged in the task). Expected
   pre-implementation; becomes fast once the bound is honored (finding 2). No
   correctness impact.

## Conclusion
All four pins are behaviorally sound, fail for the correct reasons, and resist
wrong/partial implementations (N3 especially forces the full data-flow fix).
The lone guard is green, N5/N6 are correctly deferred, and typecheck is clean.
Notes are low-severity impl-completeness/robustness items, none blocking.

VERDICT: APPROVED_WITH_NOTES
