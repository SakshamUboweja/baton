---
description: Seal the current task into a handoff bundle so another platform can resume it (narrative seal + finalize).
argument-hint: [reason for switching]
---

Seal the current session's work for a cross-platform handoff.

0. Ownership check: run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/baton.mjs" status --json` first. If the bundle is owned by ANOTHER platform, this is usually a handoff you have not received yet — run `/baton:receive` first (or, only for a deliberate restart, add `--take-over` to the checkpoint below). Never seal a bundle another platform still owns.
1. Write the narrative: audit every "done" claim in this session against tool evidence (test output, git state) before recording it. Checkpoint the verified state — decisions made and why, verified-done vs claimed-done, next steps, gotchas — by piping ONE JSON object of this exact shape to `node "${CLAUDE_PLUGIN_ROOT}/core/bin/baton.mjs" checkpoint --platform claude-code --json`:

   ```json
   {"schema": "baton/event@1", "events": [
     {"type": "task.update", "payload": {"goal": "<one-line task statement — the headline of HANDOFF.md and the resume prompt>"}},
     {"type": "decision", "payload": {"summary": "<what was decided and why>"}},
     {"type": "plan.step", "payload": {"id": "<step-id>", "title": "<short step name>", "status": "done|active|pending", "note": "<evidence>"}},
     {"type": "note", "payload": {"text": "<next steps / gotchas>"}}
   ]}
   ```

   `title` is what every renderer prints (HANDOFF.md checklist, resume-prompt next actions) — never omit it. Verify the envelope on stdout says `"ok":true` and `data.events` equals the number of events you sent before proceeding.
2. Seal: run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/baton.mjs" finalize --reason "$ARGUMENTS"` (add `--to <platform>` if the destination is known). If `$ARGUMENTS` is empty, ask the user why they are switching first — an empty reason is a usage error. Pass `--reason-class usage-limit` explicitly when the switch is a limit death: class inference only matches verbatim harness banners, and without the class the receive side will not keep roles off this platform (finalize warns when this gap opens).
3. Print the destination's resume command for the user:
   - Codex/Cursor/anything: `baton receive --platform <dest> --print-prompt`
   - Claude Code: `/baton:receive`

If limits are close, propose this command yourself before the session dies — a sealed bundle beats a degraded receive.
