---
description: Seal the current task into a handoff bundle so another platform can resume it (narrative seal + finalize).
argument-hint: [reason for switching]
---

Seal the current session's work for a cross-platform handoff.

1. Write the narrative: audit every "done" claim in this session against tool evidence (test output, git state) before recording it. Checkpoint the verified state — decisions made and why, verified-done vs claimed-done, next steps, gotchas — by piping ONE JSON object of this exact shape to `node "${CLAUDE_PLUGIN_ROOT}/core/bin/baton.mjs" checkpoint --platform claude-code`:

   ```json
   {"schema": "baton/event@1", "events": [
     {"type": "decision", "payload": {"summary": "<what was decided and why>"}},
     {"type": "plan.step", "payload": {"id": "<step-id>", "status": "done|pending", "note": "<evidence>"}},
     {"type": "note", "payload": {"text": "<next steps / gotchas>"}}
   ]}
   ```
2. Seal: run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/baton.mjs" finalize --reason "$ARGUMENTS"` (let the reason class be inferred; add `--to <platform>` if the destination is known).
3. Print the destination's resume command for the user:
   - Codex/Cursor/anything: `baton receive --platform <dest> --print-prompt`
   - Claude Code: `/baton:receive`

If limits are close, propose this command yourself before the session dies — a sealed bundle beats a degraded receive.
