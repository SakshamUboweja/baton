# Gate-2 iteration-3 collated findings

Reviewer A (gpt-5.6-sol xhigh): BLOCKED — 3 blocking, 7 major, 1 minor (11).
Reviewer B (claude-fable-5 xhigh, fresh): BLOCKED — 1 blocking, 2 major, 3 minor (6).

Deduplicated union (severity = the higher of the two when both raised it). Both reviewers independently hit the resolver-eligibility crux (F1) and the lock-journaling regression (F2). Several are iteration-2 folds that fixed one code path but missed a sibling.

| # | sev | area | file:line | A | B | fix |
|---|-----|------|-----------|---|---|-----|
| F1 | blocking | resolver eligibility | resolve.mjs:22 (+ doctor dims) | #6 | #1 | {installed,ok} = selectable+degraded, not skipped-unauthenticated; skip only on verified failure ({installed} AND outcome≠ok) |
| F2 | blocking | lock journal seq (my iter-4 regression) | lock.mjs:176,302 | #1 | #2 | journal takeover AFTER publishOwner (under the held lock); recoverLock note under a re-acquired withLock; relax test to ≤1 note |
| F3 | blocking | merge roles.remap null values | merge.mjs:76-82 | #2 | — | validate each assignment VALUE is a non-null object, else refusalNote |
| F4 | blocking | doctor probe-cache write unjailed | doctor.mjs:262-263 | #3 | (noted) | guard the cache write with checkHandoffTree (symlink escape); atomic write already prevents torn cache |
| F5 | major | checkpoint stale git on refresh failure | checkpoint.mjs:286-293 | #4 | — | on git-capture failure set explicit unavailable state + warning, never retain stale |
| F6 | major | Windows drive-root ascent + jail construction | shared.mjs:48-53; jail.mjs:60-62 | #5 | — | volume-aware path ops; normalize trailing root separator so C:/ → C:/.handoff |
| F7 | major | probe cover ASCII-only → non-ASCII catastrophic overlay | probe.mjs:23-35 | #9 | #3 | fill cover from the pattern's own literals + one member per class |
| F8 | major | subcommand --help bypasses JSON envelope | cli.mjs:108-110 | #8 | — | route subcommand-help through the envelope when global json intent set |
| F9 | major | checkpoint transcript containment Windows separator | checkpoint.mjs:48-64 | #10 | #6 | separator-normalize both realpaths before containment (share norm helper) |
| F10 | major | commit seals low-confidence class → laundered high | txn.mjs:202,125-127 | #7 | #5 | seal reasonClass only for explicit intake or confidence≥medium; don't carry stale class into new open generation |
| F11 | minor | --reason-class enum unvalidated | receive.mjs:15-39 | #11 | — | reject values outside {usage-limit,auth,throttle,other-error} before prepare/commit |
| F12 | minor | sessionStart raw bundle read + untrusted origin | hook.mjs:119-140 | — | #4 | checkHandoffTree first; allowlist origin against {codex,cursor} else generic label |

Fold order (groups, each tests-first → implement → gate → commit):
1. F6+F9 (Windows path normalization — shared helper) — the class fix.
2. F1 (resolver eligibility) + resolver test.
3. F2 (lock journaling under lock) + test relaxation.
4. F3 (merge remap null values) + F4 (doctor cache jail).
5. F7 (probe cover from pattern).
6. F8 (subcommand help envelope) + F10 (low-confidence seal) + F11 (reason-class enum) + F12 (sessionStart).
