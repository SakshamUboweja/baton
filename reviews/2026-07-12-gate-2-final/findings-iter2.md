# Gate 2 — collated findings (iteration 2)

Reviewer A: gpt-5.6-sol @ xhigh (codex exec, read-only) — **BLOCKED**, 13 findings (6 blocking, 7 major).
Reviewer B: claude-fable-5 @ xhigh (fresh-context subagent) — **APPROVED_WITH_NOTES**, 2 findings (1 major, 1 minor); all five iteration-1 live repros confirmed closed, git history clean.

Gate stays BLOCKED (reviewer A). Full verdicts under reviewer-a/iteration-02/ and reviewer-b/iteration-02/. All A findings spot-checked against the code and confirmed real (A6 both sub-cases reproduced live). Deduped work list, dependency-ordered:

## Blocking

B1. **Lock dead-takeover not atomic** [A3] — the dead branch calls publishOwner without re-claiming the lock dir; two contenders that both read the stale owner both publish tokens. Fix: atomically remove+recreate the lock dir (mkdir EEXIST) to claim before publishing; barrier-test two contenders vs one dead lock.

B2. **Lock / recover / hook-log mutate .handoff before the jail** [A4] — withLock/recoverLock and hook error logging write inside .handoff with no symlink/realpath check; a symlinked lock or log dir escapes the repo. Fix: jail before every lock/recover/log mutation; real-fs symlink tests for recover and the failing-hook path.

B3. **Regex flags not validated; worker swallows flag compile errors** [A5] — lintRegex compiles the pattern without flags; probe-worker treats a flag compile error as safe completion; `flags:"z"` loads then throws in classify. Fix: validate the pattern+flags pair, reject unsupported/duplicate flags, propagate worker compile failures distinctly from timeouts.

B4. **Nested validation still incomplete** [A6] — roles.assignments.<role>=null passes validateBundle and crashes renderHandoffMd (reproduced); a parseable `null` (or non-object) journal line crashes replay before applyEvent (reproduced). Fix: validate each assignment value; validate the journal event envelope before replay and degrade malformed entries to audit warnings.

B5. **receive.md commit step is a bare command** [A9] — prepare uses ${CLAUDE_PLUGIN_ROOT} but the commit step tells the harness to run bare `receive --platform …`, not resolvable outside the baton repo. Fix: full quoted `node "${CLAUDE_PLUGIN_ROOT}/core/bin/baton.mjs" receive …`.

B6. **Seed is only a note; journal-only rebuild loses origin/identity** [A12] — replay ignores payload.seed, so deleting snapshot+backup rebuilds origin as unknown and drops bundleId/task/generation; the test only checked the decision text. Fix: a self-applying seed/state event carrying bundleId, origin, task, generation; assert those after journal-only recovery.

## Major

M1. **Git captured only on important checkpoints** [A1] — routine Stop/file-touch rewrites keep stale/null git even when the snapshot is rewritten. Fix: refresh bounded git state on every snapshot rewrite, with an explicit unavailable state.

M2. **Windows path handling in root discovery + jail** [A2] — resolveRoot splits only on `/`; jail compares a native realpathSync result to a forward-slash string, so Windows paths fail discovery and reject existing .handoff trees. Fix: node:path operations + volume-aware containment; Windows-path tests.

M3. **Doctor probe dimensions conflated** [A7] — a successful `claude --version` is recorded authenticated/reachable; absent probe data isn't marked degraded; installed/enabled/trusted/observed aren't distinct. Fix: separate version/install from auth/reachability, represent unknown dimensions explicitly, flag offline selections degraded.

M4. **classifyReason discards confidence** [A8] — Cursor's low-confidence "quota exceeded" heuristic silently adds cursor to avoid[]. Fix: retain the verdict, warn on low confidence, require explicit intake before avoidance.

M5. **Debounce stamp check-and-set outside the lock** [A10] — two simultaneous afterFileEdit hooks can both see no stamp and both checkpoint. Fix: serialize the stamp under the repo lock; barrier-test concurrent debounce.

M6. **Envelope contract still partial** [A11] — `baton --json` (no command / help) emits no envelope; `receive --print-prompt --json` emits raw markdown. Fix: parse global JSON intent before dispatch; route every path through one emitter.

M7. **Concurrent-receiver acceptance test still sequential** [A13] — competing commits are invoked in series; the genuinely-concurrent receiver case is absent. Fix: two prepared receipts, two commit child processes released from one barrier; assert exactly one transition, loser untouched.

M8. **Regex probe input-alphabet hole** [B1] — probe inputs are built only from literal [A-Za-z0-9]; a group-free chained-star over \d/\s/[!-/] passes the scanner AND the probe, then hangs classify (synchronous, no cap/guard). Operator-only trust boundary (--signatures), so B did not block. Fix: per-character-class probe inputs, OR a runtime bounded-match guard in classify.

## Minor

m1. **transcript_path not jailed** [B2] — under opt-in capture, transcript_path is taken verbatim from the untrusted payload and can name any readable regular file. Symlinks already refused; redaction verified. Fix: confine transcript_path within the repo root (realpath/jail) or a configured dir.

## Clean (reconfirmed by both reviewers)

Git history sole-author + zero AI attribution; all five iteration-1 live repros closed; attribution suite, recovery ladder, session gating, envelopes-where-present, templates + init --check, symlink jail, lock non-stealing.
