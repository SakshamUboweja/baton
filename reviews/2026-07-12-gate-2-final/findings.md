# Gate 2 — collated findings (iteration 1)

Reviewer A: gpt-5.6-sol @ xhigh (codex exec, read-only) — BLOCKED, 16 findings.
Reviewer B: claude-fable-5 (fresh-context subagent) — BLOCKED, 26 findings, with live reproductions.
Full verdicts: reviewer-a/iteration-01/verdict.md, reviewer-b/iteration-01/verdict.md.

Deduped work list, dependency-ordered. [A#/B#] = source finding numbers.

## Blocking

1. **Hook script never runs in production** [B1] — hook.mjs has no main entry (`runHook` exported, never invoked as a script) and forwards stdin via an `{input}` option async execFile doesn't support. The shipped Claude Code adapter checkpoints exactly never. Fix: argv main guard building real io; stdin via spawn/execFileSync input; spawn-level integration test executing the script exactly as hooks.json does.
2. **Session ownership seams** [A2, B3, B5] — (a) auto-seed never adopts the incoming stable hint → foreign-session isolation never engages; (b) receive defaults sessionHint `cli:<host>` marked stable, adapters pass no --session → first real post-receive hook rejected as foreign. Fix: adopt-on-seed from first stable event; defaulted receive hint marked unstable + checkpoint adopts first stable same-platform hint after a receive; contract test with a hint receive never saw.
3. **StopFailure never marks limit-hit** [A3, B14] — detect verdict discarded; handoff.reasonClass stays null; SessionStart pending notice can never fire for unsealed limit death. Fix: merge-reducer event (e.g. `handoff.update`/limit-hit) emitted by the hook on rate_limit; assert persisted bundle state.
4. **Receive commit not atomic** [A1, B11, B12, B2, B13] — token check + three mutations under separate locks; guardedWrite unused in the mutation path; lock takeover notes lack seq/dedupeKey (NaN journalSeq poisoning — B2's live repro lost a seal); processAlive treats EPERM as dead and startTime is never compared. Fix: single withLock across the whole commit with lock-context store variants; token additionally binds handoff.status + receive_log.length; fence-check before each write; lock notes through seq/dedupeKey allocation; applyEvent hardened against keyless events; EPERM=alive + real start-time compare.
5. **No root discovery / --root ignored** [A5, B10] — all commands use io.cwd verbatim; subdirectory runs seed stray bundles. Fix: central resolver (.handoff|baton.config.json ancestor → git toplevel → cwd; stop at nested .git; --root override) threaded through every command.
6. **Threat model gaps** [A6, A7, A8, B6, B7] — no symlink refusal (purge follows links outside the repo); regex lint misses `(a|a)*x`-class patterns and no runtime match guard (93.8 s hang reproduced); nested bundle shapes unvalidated (string constraints crash render; absolute/`..` paths stored verbatim). Fix: lstat + realpath jail on the managed tree; bounded match guard (worker or load-time pathological probe); deep schema validation + path normalization/jailing.
7. **Adapter command paths break outside the repo** [A10, B17] — commands say `node core/bin/baton.mjs`; only resolves inside baton itself. Fix: `${CLAUDE_PLUGIN_ROOT}/core/bin/baton.mjs` in all three command bodies.
8. **Codex/Cursor SessionStart unguarded** [A11, B15] — unconditional full receive prep: exit-1 noise with no bundle, resume prompt for own open bundle, wrong output shape for Cursor. Fix: pending check (sealed-or-limit-hit AND foreign) via a cheap status path; harness-specific context output; always exit 0.
9. **Templates below contract** [A13, B18] — AGENTS.md.tpl missing most mandated sections incl. the attribution invariant; no init --check drift test. Fix: render the ten-section contract within budgets; add init --check.
10. **Unwired plan features in checkpoint pipeline** [A4, B8] — no git capture on checkpoint, no opt-in transcript capture at PreCompact (config key ships dead), compact() never called at runtime. Fix: bounded git refresh on important checkpoints; config-gated redacted tail capture; compaction in the snapshot write path. (Transcript: implement minimal plan-compliant version — capture.transcriptTail respected, redaction patterns, bounded.)
11. **recover unimplemented + envelope gaps** [A14, B9] — recover in the frozen list returns not-implemented; checkpoint --json emits no envelope; usage errors bypass the envelope contract. Fix: cmdRecover over recoverLock; centralize envelope emission.
12. **Acceptance-suite fidelity** [A16] — concurrency tests use pre-created locks/sequential commits; StopFailure tests assert argv not persisted state; complicit test patterns B called out (echoed hints, fake execFile input). Fix: barrier-controlled child-process concurrency tests; adapter-to-core state tests; symlink/traversal fixtures. Test changes re-enter test-verifier review.

## Major

13. **Doctor gaps** [A9, B16, B25] — version floors, trust/canary states, network-fs detection, --version capped at installed, probe cache consumed by receive/remap (+ probe snapshot into the token).
14. **Cursor afterFileEdit debounce missing** [A12, B26] — checkpoint --debounce flag; cursor hook uses it.
15. **.bak can be overwritten by a corrupt snapshot** [A15] — validate before backup; journal seed events for lossless rebuild.

## Minor

16. reason-class validation on finalize [B19]; purge marker never auto-resumed [B20]; marker reconciliation writes on read paths un-locked [B21]; status bypasses loadBundle [B22]; hook errors unlogged / no .handoff/log retention [B23]; history freeze copy non-atomic [B24].

## Clean

Git history: sole author, zero AI attribution (verified independently by both reviewers). Attribution invariant suite, lock refusal semantics, recovery ladder, scaffold purity, init idempotency, detect exit codes, prompt caps, token drift binding — all confirmed faithful.
