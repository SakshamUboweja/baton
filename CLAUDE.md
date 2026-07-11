@AGENTS.md

## Claude Code specifics

- Delegate parallelizable research and verification to subagents; communicate with them asynchronously instead of blocking.
- Role mechanics on this machine: test-author via the Agent tool with an Opus model override; plan-reviewer, test-verifier, and final-reviewer-a via the Codex runtime (`codex exec -s read-only`, model/effort per `baton.config.json`).
- Plans go through plan mode and land in `docs/plans/`.
- Attribution is enforced by `{"attribution": {"commit": "", "pr": ""}}` in Claude Code settings; `baton doctor` checks it.
- Commit each completed subtask; never batch a day's work into one commit.
- Prefer `/baton:*` commands over ad-hoc checkpointing once the plugin is installed.
- User-facing outputs: simple and concise — outcome first, plain language.
