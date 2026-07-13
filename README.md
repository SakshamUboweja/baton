# baton

Usage-limit failover for AI coding sessions. When Claude Code, Codex CLI, or Cursor dies mid-task — limits, crash, or preference — baton has already checkpointed the work into a portable bundle, and the next platform picks it up: same task, same plan, roles remapped to the models that platform offers.

## What it does

- **Checkpoints continuously** via each harness's native hooks (no LLM cost): git state, files touched, plan progress, decisions.
- **Seals a handoff** (`/handoff` or `baton finalize`) with the reason you're switching.
- **Resumes anywhere**: the receive command asks where you came from and why, loads the bundle, remaps roles from your committed `baton.config.json` (e.g. reviewer: gpt-5.6-sol → fallback opus-4.8), and continues the task.
- **Detects limit deaths** with structured signals where they exist (Claude Code `StopFailure`) and versioned text signatures elsewhere.
- **Scaffolds an ideal `AGENTS.md` + `CLAUDE.md` pair** so all three platforms follow one workflow contract.

baton **complements** native configs — AGENTS.md, CLAUDE.md, and `.cursor/rules` stay canonical. It never wraps or proxies a harness. Delete `.handoff/` and everything works as before.

## Install

| Harness | Command |
|---|---|
| Claude Code | `/plugin marketplace add SakshamUboweja/baton` → install `baton` |
| Codex CLI | `npx @sakshamuboweja/baton init --codex` |
| Cursor | `npx @sakshamuboweja/baton init --cursor` |
| Anything else | `baton receive --platform codex --print-prompt` (pure CLI — pass the supported platform whose role defaults best fit the target harness) |

## Status

Under construction — v1 (failover layer) in progress. See `docs/plans/` for the approved plan and `reviews/` for the gate history.

## License

MIT
