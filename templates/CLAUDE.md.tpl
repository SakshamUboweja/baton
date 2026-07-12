@AGENTS.md

## Claude Code specifics (baton)

- Prefer `/baton:*` commands over ad-hoc checkpointing once the baton plugin is installed.
- On session start after another platform's limit death, expect a "handoff pending" notice — run the receive flow before new work.
- Delegate parallelizable research and verification to subagents; the main thread owns the task across handoffs.
- Reviewer and verifier roles run on their configured platform — resolve with `baton remap`, never by naming models.
- Plans live in `docs/plans/`; review artifacts under `reviews/<task-id>/`.
- Keep `{"attribution": {"commit": "", "pr": ""}}` in `.claude/settings.json` (`baton doctor` checks it).
- Commit each completed subtask; never batch a day's work into one commit.
- User-facing outputs: outcome first, plain language, no jargon walls.
