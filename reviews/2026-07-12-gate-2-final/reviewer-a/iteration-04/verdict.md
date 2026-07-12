role: final-reviewer-a (gate 2, iteration 4)
model: gpt-5.6-sol @ xhigh
harness: codex exec -C <repo> -s read-only
date: 2026-07-12
verdict: BLOCKED
degraded: none
scope: e4acd79..HEAD (ce17b78) — the iteration-3 fold + coverage

167,267
Gate 2 iteration 4 remains blocked. The targeted suite passed 116/116 and typecheck is clean; all reviewed commits have the required sole author. However, four prior findings remain incomplete, with additional lock and path-helper regressions.

The verified-closed iteration-3 findings are #1, #2, #3, #5, #8, #10, and #11. F12, originating from reviewer B, is also correctly fixed.

VERDICT: BLOCKED
DISPOSITIONS: 7 of 11 iteration-3 findings verified closed; NOT closed: #4 (F5), #6 (F1), #7 (F10), #9 (F7)
FINDINGS:
1. [blocking] — core/src/bundle/lock.mjs:297-312 — `recoverLock` decides that the owner is dead and then recursively removes the canonical lock path; a contender can atomically replace the stale directory with a live lock between those operations, which recovery then deletes, allowing concurrent mutation — plan §Concurrency atomic lock acquisition — Fix: arbitrate recovery through the same atomic rename-and-fresh-mkdir mechanism as normal dead-lock takeover; never `rmSync` the canonical path based on an earlier inspection.
2. [major] — core/src/bundle/lock.mjs:179-189 — takeover journaling occurs after publishing the new owner but before `acquire` returns its token; if `journalNote` throws, `withLock` never enters its release `finally`, leaving the newly published lock behind — plan §Concurrency; iteration-3 finding #1/F2 — Fix: make the audit append genuinely best-effort after publication, returning the token even when it fails, or explicitly release the published lock before rethrowing.
3. [major] — core/src/commands/checkpoint.mjs:290-297 — when the git refresh returns null, the code leaves `merged.git` unchanged; a reproduction retained `oldsha`, and no degradation warning is emitted — plan §Root discovery & degraded modes; iteration-3 finding #4/F5 — Fix: replace the prior git snapshot with an explicit unavailable/null state and emit a warning whenever refresh fails.
4. [major] — core/src/roles/resolve.mjs:34-41 — degradation still ignores probe outcome: `{capability:"authenticated", outcome:"error"}` and `{capability:"reachable", outcome:"timeout"}` are selected without `degraded`, silently presenting failed reachability as verified healthy — plan §Role matrix availability probing; iteration-3 finding #6/F1 — Fix: mark a selection degraded whenever any required dimension is unverified or the non-rate-limited outcome is not `ok`, while retaining the intended `{installed,ok}` selectable/degraded behavior.
5. [major] — core/src/commands/doctor.mjs:81-105 — doctor still collapses installed, enabled, trusted, and observed-executing into one prose check; trusted is only mentioned as possible guidance and enabled is not represented independently — plan §Codex adapter trust gate; iteration-3 finding #6/F1 — Fix: report four explicit per-hook state fields, including `unknown` where trust cannot be verified, and gate fidelity on the observed state.
6. [major] — core/src/receive/txn.mjs:231-242 — the new open generation spreads the received seal and changes only `status`, retaining an earlier `reasonClass`, reason, and finalized metadata; a normal sealed usage-limit receive therefore causes the next receive to trust the previous generation’s class against the newly adopted origin — plan §Concurrency fresh writable generation and §Limit detector; iteration-3 finding #7/F10 — Fix: clear `reason`, `reasonClass`, `finalizedAt`, and `toPlatformHint` when constructing the fresh open generation.
7. [major] — core/src/detect/probe.mjs:21-22,66-68 — the supposedly non-matching tail remains fixed at U+0001; the exact prior repro, twelve `.*` atoms followed by `\x01`, is still declared safe in about 21 ms, while a 20-character nonmatching input took about 4.5 s — plan §Limit detector hardening; iteration-3 finding #9/F7 — Fix: structurally reject overlapping chained quantified atoms, with the fixed-tail pattern as a regression test; deriving fills from literals does not guarantee a nonmatching tail.
8. [minor] — core/src/util/pathnorm.mjs:38-41 — `isContained("/", "/transcript.jsonl")` returns false because it tests a `//` prefix, so the shared helper refuses valid containment for a repository rooted at `/` — plan §Root discovery, §Transcript policy; changed surface from iteration-3 findings #5/#10 — Fix: handle volume roots explicitly when constructing the containment prefix and add POSIX-root coverage.
