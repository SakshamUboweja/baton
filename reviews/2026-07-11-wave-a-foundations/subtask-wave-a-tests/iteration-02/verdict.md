role: test-verifier
model: gpt-5.5 @ xhigh
harness: codex exec -s read-only (codex-cli 0.144.1)
date: 2026-07-11
verdict: BLOCKED
degraded: none
note: single finding; fix prescribed verbatim by verifier and applied by orchestrator

VERDICT: BLOCKED
FINDINGS:
1. [blocking] — tests/integration/cli-spawn.test.mjs / `every documented command is recognized` — the unknown baseline is `definitely-not-a-command`, but the documented commands are invoked as `<cmd> --help`; an implementation that handles any `--help` globally before dispatch could pass while still omitting all command routes. The 10-13 exit-code matrix deferral is acceptable given the later detect/cli-shell tasks, but this recognition test is still weak. Fix by using an equivalent unknown baseline (`definitely-not-a-command --help`) and/or asserting command-specific help/dispatch evidence for each documented command.
