# Gate-2 iteration-4 collated findings

Reviewer A (gpt-5.6-sol xhigh): BLOCKED — 1 blocking, 6 major, 1 minor (8). Verified closed: iter-3 #1,#2,#3,#5,#8,#10,#11 + F12.
Reviewer B (claude-fable-5 xhigh, fresh): BLOCKED — 3 major, 3 minor (6). Verified closed: all 6 of its iter-3 findings.

Deduplicated union (severity = higher of the two). Both independently hit F5-missed, F10-generation-carry, and the F7 probe hole. Root cause of the recurrence: the iteration-3 fold dropped F5 entirely and implemented F10/F7 partially.

| # | sev | area | file:line | A | B | fix |
|---|-----|------|-----------|---|---|-----|
| I1 | blocking | recoverLock TOCTOU (inspect→rmSync) | lock.mjs:297-304 | #1 | #5 | reuse the atomic acquire (rename-arbitrated dead-reclaim) + release; never rmSync the canonical path on a stale inspection |
| I2 | major | F5 checkpoint stale git (NEVER FOLDED) | checkpoint.mjs:295-296 | #3 | #1 | on git-refresh failure set git=null (explicit unavailable) + warning; never retain stale |
| I3 | major | F10 gen-carry: new open generation keeps seal's reason/class | txn.mjs:232-242 | #6 | #2 | reset reason/reasonClass/finalizedAt/toPlatformHint to null in `next` (keep receive_log); sealed-path regression test |
| I4 | major | F7 probe misses escaped-metachar / control literals | probe.mjs:26,44-48 | #7 | #3 | STRUCTURAL: reject chained overlapping unbounded-quantified atoms at load; ALSO decode `\n\t\(…` as content fills (defense-in-depth) |
| I5 | major | doctor four-state not distinct | doctor.mjs:81-105 | #5 | — | report installed/enabled/trusted/observed as explicit per-hook fields (unknown where unverifiable) |
| I6 | major | resolver ignores non-ok outcome for degraded | resolve.mjs:34-41 | #4 | — | flag degraded when outcome !== 'ok' (authenticated/reachable + error/timeout), keeping {installed,ok} selectable+degraded |
| I7 | minor | takeover journalNote can leak the lock if it throws | lock.mjs:188 | #2 | #4 | wrap the takeover journalNote in try/catch (best-effort, as recoverLock does) |
| I8 | minor | isContained POSIX root false-negative | pathnorm.mjs:38-41 | #8 | — | prefix = base.endsWith('/') ? base : base+'/' (so '/' contains '/x') |
| I9 | minor | normSep unconditional '\\'→'/' unsafe on POSIX | pathnorm.mjs:16 | — | #6 | refuse a backslash-bearing untrusted transcript realpath on non-win32 (backslash is a legal posix filename char) |

Fold order (each tests-first → implement → gate → commit):
1. I1 + I7 (lock.mjs — recoverLock atomic reuse of acquire; takeover journalNote best-effort).
2. I2 (checkpoint stale git — the missed fold).
3. I3 (txn new-generation metadata reset).
4. I6 (resolver outcome-degraded) + I5 (doctor four-state).
5. I4 (probe structural chained-atom rejection + escape-decode fills).
6. I8 + I9 (pathnorm POSIX root + posix-backslash refusal).

After folding: a completeness-critic pass (verify EACH finding is folded across ALL paths — the recurring miss) before Gate-2 iteration 5 (the last allowed).
