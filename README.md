# baton

**Usage-limit failover for AI coding sessions.** When Claude Code, Codex CLI, or Cursor dies mid-task — limits, a crash, or your own choice — baton has already checkpointed the work, and the next platform picks it up: same task, same plan, model roles remapped to whatever that platform offers.

## Why

Your workflow spans more than one AI harness, and any one of them can run out of quota in the middle of a task. Normally the work, the plan, and the context die with that session. baton keeps a portable, always-current handoff bundle on disk so you can switch platforms without losing your place.

## What it does

- **Checkpoints continuously** through each harness's native hooks — no LLM cost. Captures git state, files touched, plan progress, and decisions.
- **Seals a handoff** (`/handoff` or `baton finalize`) that records why you're switching.
- **Resumes anywhere** — loads the bundle, remaps roles from your `baton.config.json`, and continues the task on the new platform.
- **Detects limit deaths** with structured signals where they exist, and versioned text signatures elsewhere.

baton complements your setup — `AGENTS.md`, `CLAUDE.md`, and `.cursor/rules` stay canonical. Delete `.handoff/` and everything works exactly as before.

## Install

| Harness | Command |
|---|---|
| Claude Code | `/plugin marketplace add SakshamUboweja/baton` → install `baton` |
| Codex CLI | `npx @sakshamuboweja/baton init --codex` |
| Cursor | `npx @sakshamuboweja/baton init --cursor` |
| Anything else | `baton receive --platform <p> --print-prompt` (pure CLI) |

## Two presets on top

Built on the same engine:

- **`baton loop`** — a goal supervisor that drives a repo-local `loop.json` plan through headless writer/reviewer roles, with a smoke-test approval gate and explicit park / resume / escalate.
- **`baton pipeline`** — a dual-worktree write → review → merge cycle across two isolated git worktrees, merging only after two independent read-only checks pass.

## Documentation

This repo dogfoods baton: the root `AGENTS.md` and `CLAUDE.md` are the operating contract its own AI sessions follow, and `templates/` holds the pair baton scaffolds into your projects. See [`docs/architecture.md`](docs/architecture.md) for how the bundle, detection, remap, and receive transaction fit together.

## License

MIT
