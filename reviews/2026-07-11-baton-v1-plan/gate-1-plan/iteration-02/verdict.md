role: plan-reviewer
model: gpt-5.6-sol @ xhigh
harness: codex exec -s read-only (codex-cli 0.144.1)
date: 2026-07-11
verdict: BLOCKED
degraded: none

VERDICT: BLOCKED

FINDINGS:

1. [blocking] — Core engine / Receive — “atomically flips `status: sealed → received`” cannot handle the primary failure case: a usage limit can terminate the session before `finalize`, leaving an `open` bundle marked `limit-hit`. The plan itself says receive must compensate for a missing seal, yet commit only accepts `sealed`. — Define and test an atomic `open+limit-hit → received` transition that records a degraded, receive-generated seal; include it in all six directional tests.

2. [blocking] — Cursor adapter — “`onPostEdit` … and `onPreCommit`” names unsupported Cursor events. Cursor uses `afterFileEdit`, and Cursor staff explicitly state there is no pre-commit event; agent-issued commits can only be observed through `beforeShellExecution`. Thus the proposed adapter may never checkpoint. ([Cursor staff clarification](https://forum.cursor.com/t/project-level-hooks-fail-to-execute-on-windows/144940/3)) — Replace the events, add fixture and live IDE/CLI dispatch tests, and document that SCM-UI commits are invisible.

3. [major] — Bundle / Out of scope — “single active bundle” plus “supports multiple writers” makes concurrent commands mechanically serialized but not semantically isolated. Two sessions working on different tasks will merge goals, files, decisions, and roles into one handoff. — Either add bundle IDs in v1 or enforce one active task/session group, rejecting foreign `sessionHint` writers with an actionable warning.

4. [major] — Concurrency — “stale locks … are taken over” lacks fencing. A paused writer can be declared stale, resume after takeover, and mutate state concurrently with the new owner; heartbeat and `writerId` do not prevent this ABA race. — Give each acquisition a random fencing token, verify ownership immediately before every write/rename and release, define heartbeat cadence, and test a paused old writer resuming after takeover.

5. [major] — Codex adapter — “mechanical staleness ≤ 1 turn via Stop hook” omits Codex’s per-definition hook trust gate. Project hooks are skipped until the exact definition is reviewed, and changes invalidate prior trust, so installation alone does not provide the stated fidelity. ([Official Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)) — Make setup and doctor report installed/enabled/trusted/executed separately, guide users through `/hooks`, and gate the fidelity claim on an observed hook canary.

6. [major] — Transcript policy — “purgeable via `--purge-transcript`” does not say whether purge rewrites `.bak`, journals, and the ten retained history freezes. Secrets can therefore remain after a reported purge. — Define purge as an atomic rewrite/rotation of every retained copy, or clearly expose scoped deletion commands and test that planted secrets disappear from the entire `.handoff/` tree.

7. [major] — Build order — Core `scaffold`, `init`, and the init-based e2e precede “Templates + methodology,” although init requires those templates. Packaging CI is only an acceptance statement, with no late build task after adapters exist. — Move templates before scaffold/init, and add an explicit packaging commit covering `files`/exports/bin/shebang, packed-install adapter paths, and Linux/macOS/Windows execution.

8. [minor] — Locked decisions / Acceptance — “sole contributor `SakshamUboweja`” still contradicts “external OSS contributors are welcome post-v1.” — Scope sole authorship consistently to initial construction/pre-v1 everywhere; keep only the no-AI-attribution rule permanent.

MISSING:

- Define Windows hook commands (`commandWindows`/`.cmd`), rename-retry behavior, path quoting, and platform-specific integration tests.
- Define noninteractive, time-bounded availability probes and distinguish installed, authenticated, reachable, rate-limited, and unknown.
- Bound root discovery at nested independent Git repositories unless explicitly overridden.
- Add a per-finding Gate-1 disposition table: most prior findings are adequately addressed, but receive atomicity, transcript purge, sole-author scoping, and executable build/packaging ordering remain incomplete.
