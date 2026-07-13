---
name: handoff-protocol
description: Use when resuming a task received from another platform via baton, or when preparing to hand one off — governs evidence auditing, checkpoint cadence, and continuation discipline across cross-harness handoffs.
---

# Handoff protocol

The main thread owns a received task — never delegate the continuation itself to a subagent (a subagent would strand the context the bundle just restored).

## Receiving

- Treat every bundle claim as unverified: audit HANDOFF.md's "done" statements against live git state and the working tree before acting on them.
- Announce the role remap table to the user before continuing.
- Continue from the first pending plan step; do not re-litigate decisions the bundle records unless the evidence audit contradicts them.

## While working

- Checkpoint after each completed subtask, before risky operations, and at wind-down: pipe one JSON object to `node "${CLAUDE_PLUGIN_ROOT}/core/bin/baton.mjs" checkpoint --platform claude-code --json` (a plugin install puts no `baton` on PATH) and confirm the envelope's `data.events` matches what you sent. Payload shapes:
  - `{"type":"decision","payload":{"summary":"<what and why>"}}`
  - `{"type":"plan.step","payload":{"id":"<id>","title":"<short step name — every renderer prints title>","status":"done|active|pending","note":"<evidence>"}}`
  - `{"type":"note","payload":{"text":"<gotcha / next step>"}}` · `{"type":"file.touch","payload":{"path":"<repo-relative — absolute paths are refused by the jail>","op":"edit|write"}}`
  - `{"type":"task.update","payload":{"goal":"<one-line task statement>"}}` — set this early; it is the headline of HANDOFF.md and the resume prompt (else both read "unknown").
  Wrap them as `{"schema":"baton/event@1","events":[…]}`.
- Keep decisions honest: record verified-done vs claimed-done separately.

## Handing off

- Near a usage limit, propose `/baton:handoff` proactively — a narrative seal beats a degraded receive.
- The seal reason should say why the switch is happening. Inference only matches verbatim harness limit banners — for any forced switch pass `--reason-class <usage-limit|throttle|auth|other-error>` explicitly, or receive will not keep roles off the exhausted platform.
