role: final-reviewer-b (gate 2, iteration 3, fresh context)
model: claude-fable-5 @ xhigh
harness: Claude Code Agent tool (general-purpose subagent)
date: 2026-07-12
verdict: BLOCKED
degraded: none
scope: 0bac1a0..HEAD (6a963c9); npm test 732/732, typecheck clean; 4 live experiments

VERDICT: BLOCKED
FINDINGS:
1. [blocking] — core/src/roles/resolve.mjs:22 (with core/src/commands/doctor.mjs PROBES capOnSuccess) — a healthy claude-code probe records {capability:'installed', outcome:'ok'} and the resolver hard-skips it as 'unauthenticated' in every chain (and refuses forced-default), so any receive/remap within 15 min of a doctor run excludes a fully healthy claude-code — demonstrated live — plan §Role matrix ("anything with an unverifiable dimension resolves as selectable-with-degraded-flag") — Fix: return 'unauthenticated' only for a verified auth failure (capability 'installed' AND outcome !== 'ok'); treat {installed, ok} as selectable with degraded: true, add a resolver test over the healthy-machine cache.
2. [major] — core/src/bundle/lock.mjs:176 (also :302) — journalNote appends and allocates seq while the lock is NOT held (dead-reclaim after rename-aside; recoverLock after rmSync), so the takeover note can collide seq with a real event and replay (store.mjs:155) silently drops the second same-seq entry — plan §Concurrency "sequence numbers are allocated under the lock" — Fix: journal after publishOwner while holding the lock (accept note loss when the mkdir race is lost), or defer via a marker drained under the lock.
3. [major] — core/src/detect/probe.mjs:23-35 — the covering alphabet and literal extraction are ASCII-only, so a group-free chained-star overlay over a non-ASCII literal/class probes {safe:true} and then hangs detect end-to-end (verified, killed at 8s); operator-only trust boundary — plan §Threat model / §Limit detector time guard — Fix: fill the cover from the pattern itself (a member of every class + all literal code points), or add a bounded-match runtime guard in classify().
4. [minor] — adapters/claude-code/scripts/hook.mjs:119-140 — sessionStart reads .handoff/bundle.json raw (bypassing loadBundle's jail/validation) and interpolates the unbounded untrusted origin string into the SessionStart additionalContext — plan §Threat model / adapter fixed-suggestion string — Fix: checkHandoffTree first and allowlist origin against {codex, cursor} else a generic label.
5. [minor] — core/src/receive/txn.mjs:202 (with :125-127,:226) — commit persists a LOW-confidence live classification into the degraded seal's reasonClass ungated, and the next prepare treats any sealed reasonClass as confidence 'high', laundering the M4 guard into auto-avoidance one hop later — plan §Limit detector low-confidence — Fix: persist reasonClass only for explicit intake or confidence ≥ medium, or persist confidence and gate at prepare.
6. [minor] — core/src/commands/checkpoint.mjs:48-64 — the transcript-path allowlist compares raw realpathSync outputs without separator normalization, so on Windows containment never matches and opt-in capture silently never captures — plan §Transcript policy — Fix: normalize both sides to forward slashes before the containment compare (share the jail norm helper).
ATTRIBUTION: pass — 70 commits, sole author+committer SakshamUboweja <ssakshamu@gmail.com>, zero AI-attribution strings; git-guard + invariant suite present.
TESTS: npm test 732/732 pass (235 suites, 0 fail, 0 skipped); npm run typecheck clean.
