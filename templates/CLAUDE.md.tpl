@AGENTS.md

## Claude Code specifics (baton)

- Prefer `/baton:*` commands over ad-hoc checkpointing once the baton plugin is installed.
- On session start after another platform's limit death, expect a "handoff pending" notice — run the receive flow before new work.
- Delegate parallelizable research and verification to subagents; the main thread owns the task across handoffs.
