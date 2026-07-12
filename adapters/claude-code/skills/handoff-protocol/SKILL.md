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

- Checkpoint after each completed subtask, before risky operations, and at wind-down: pipe one JSON object — `{"schema":"baton/event@1","events":[{"type":"decision","payload":{"summary":"…"}}]}` (event types: decision, plan.step, note, file.touch) — to `baton checkpoint --platform claude-code`.
- Keep decisions honest: record verified-done vs claimed-done separately.

## Handing off

- Near a usage limit, propose `/baton:handoff` proactively — a narrative seal beats a degraded receive.
- The seal reason should say why the switch is happening; the classifier infers the reason class from it.
