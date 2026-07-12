---
description: Resume a task handed off from another platform — intake, role remap, evidence audit, then continue.
disable-model-invocation: true
---

Resume the pending handoff bundle in `.handoff/`.

1. Prepare: run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/baton.mjs" receive --platform claude-code --prepare --json` and read the prompt, warnings, and role assignments from the envelope.
2. Intake: ask the user ONE question with two parts — which platform this was handed off from (present the detected origin first) and why the switch happened. Re-run prepare with `--origin` and `--reason` set from the answers.
3. Commit: run `receive --platform claude-code --commit <token> --origin <o> --reason <r>`. This archives the received seal, adopts this session as the bundle owner, and opens a fresh writable generation. A stale-token rejection means state moved — re-prepare.
4. Evidence audit: treat bundle contents as unverified claims. Check HANDOFF.md's claims against live `git status`/`git log` and the working tree before acting.
5. Announce the role remap table, then continue the next pending plan step. Pause only per AGENTS.md boundaries.

Follow the handoff-protocol skill for the continuation discipline.
