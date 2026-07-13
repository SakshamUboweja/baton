---
description: Resume a task handed off from another platform — intake, role remap, evidence audit, then continue.
disable-model-invocation: true
---

Resume the pending handoff bundle in `.handoff/`.

1. Detect: run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/baton.mjs" receive --platform claude-code --prepare --json` and read the prompt, warnings, and role assignments from the envelope. The prompt's "Handed off from <platform>. Reason for switch: <reason>" line shows what the bundle recorded — those are the detected defaults.
2. Intake: ask the user ONE question with two parts — which platform this was handed off from (present the detected origin first) and why the switch happened. If the switch was a usage limit, note that too.
3. Prepare + commit back-to-back, with IDENTICAL intake flags on both (every intake flag is bound into the token — a flag present at one phase but not the other makes the token stale):
   - `node "${CLAUDE_PLUGIN_ROOT}/core/bin/baton.mjs" receive --platform claude-code --prepare --origin <o> --reason <r> --json` (add `--reason-class usage-limit` when the switch was a limit death — this keeps roles off the exhausted platform)
   - `node "${CLAUDE_PLUGIN_ROOT}/core/bin/baton.mjs" receive --platform claude-code --commit <token> --origin <o> --reason <r>` (repeat `--reason-class` here if you passed it at prepare)
   Commit outcomes: success archives the received seal, adopts this session as owner, and opens a fresh writable generation. `alreadyCommitted` means your receive already landed — continue, do NOT re-prepare. A stale-token error names which input drifted — fix that input and re-run BOTH phases with the same flags.
4. Evidence audit: treat bundle contents as unverified claims. Check HANDOFF.md's claims against live `git status`/`git log` and the working tree before acting.
5. Announce the role remap table, then continue the next pending plan step. Pause only per AGENTS.md boundaries.

Follow the handoff-protocol skill for the continuation discipline.
