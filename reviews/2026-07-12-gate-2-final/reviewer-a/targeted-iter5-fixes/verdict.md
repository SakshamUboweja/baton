role: final-reviewer-a — TARGETED re-review of iter-5 fixes A1/A2/A3
model: gpt-5.6-sol @ xhigh
date: 2026-07-12
verdict: BLOCKED (A1 closed, A2 closed, A3 open)

79,154
A1 and A2 are closed; A3 remains open.

- A1: Git capture precedes the lock, while reload, Git application, and fenced write share one lock ([checkpoint.mjs](/Users/saksham/baton/core/src/commands/checkpoint.mjs:303)). The deterministic takeover test passes ([checkpoint-pipeline.test.mjs](/Users/saksham/baton/tests/commands/checkpoint-pipeline.test.mjs:54)). `loadBundle` cannot deadlock here: marker reconciliation uses zero retries and defers on `LockHeldError`.
- A2: Reload, seal, fenced snapshot write, and rotation occur under one lock ([finalize.mjs](/Users/saksham/baton/core/src/commands/finalize.mjs:56)). The concurrent-decision test passes ([finalize.test.mjs](/Users/saksham/baton/tests/commands/finalize.test.mjs:144)).
- A3: `observed` still accepts any platform-sourced entry without checking `payload.trigger`. Its test explicitly treats a triggerless Codex note as the Stop canary ([doctor.test.mjs](/Users/saksham/baton/tests/commands/doctor.test.mjs:250)). A runtime check confirmed a `SessionStart` entry incorrectly activates the ≤1-turn claim. Additionally, `enabled` searches the serialized hook definition rather than verifying a command field.

Validation: targeted command tests passed 36/36; typecheck and `git diff --check` passed.

VERDICT: BLOCKED
DISPOSITIONS: A1 closed, A2 closed, A3 open
FINDINGS:
1. [major] — core/src/commands/doctor.mjs:107-140 — `observed` still becomes true for any platform-sourced journal entry, including SessionStart/PreCompact or triggerless notes, so enabled Stop plus an unrelated event incorrectly activates the ≤1-turn fidelity claim; the test at tests/commands/doctor.test.mjs:250-255 pins this incorrect behavior, and enabled also searches serialized hook metadata instead of command fields — Fix: require the platform identity plus `payload.trigger === checkpointEvent`, inspect actual command/commandWindows fields for `baton checkpoint`, and add positive Stop/stop tests plus negative SessionStart, PreCompact, triggerless, and non-command metadata cases.
