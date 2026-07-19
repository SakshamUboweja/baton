# baton

Usage-limit failover for AI coding sessions. When Claude Code, Codex CLI, or Cursor dies mid-task — limits, crash, or preference — baton has already checkpointed the work into a portable bundle, and the next platform picks it up: same task, same plan, roles remapped to the models that platform offers.

## What it does

- **Checkpoints continuously** via each harness's native hooks (no LLM cost): git state, files touched, plan progress, decisions.
- **Seals a handoff** (`/handoff` or `baton finalize`) with the reason you're switching.
- **Resumes anywhere**: the receive command asks where you came from and why, loads the bundle, remaps roles from your committed `baton.config.json` (e.g. reviewer: gpt-5.6-sol → fallback opus-4.8), and continues the task.
- **Detects limit deaths** with structured signals where they exist (Claude Code `StopFailure`) and versioned text signatures elsewhere.
- **Scaffolds an ideal `AGENTS.md` + `CLAUDE.md` pair** so all three platforms follow one workflow contract.

baton **complements** native configs — AGENTS.md, CLAUDE.md, and `.cursor/rules` stay canonical. It never wraps or proxies a harness. Delete `.handoff/` and everything works as before.

## baton loop

`baton loop` is the goal supervisor. It runs a repo-local `loop.json` plan through headless writer and reviewer roles from `baton.config.json`, records state in gitignored `.handoff/loop/`, and keeps the handoff bundle ready if a child session dies on usage limits. It supervises the boring parts that otherwise get lost between harnesses: phase position, review iteration counts, child logs, smoke-test approval, and park/resume/escalate decisions.

Quickstart:

```sh
baton loop init "<goal>"
# edit loop.json: add constraints, set smoke.cmd / smoke.expect, adjust phases if needed
baton loop run
```

`baton loop init` writes `loop.json` at the repo root and leaves an existing file untouched. `baton loop run` validates that spec against your role matrix, starts the supervisor, and runs each phase until the goal is approved, parked, or escalated. Runtime files stay under `.handoff/loop/`; the committed contract is `loop.json` plus `baton.config.json`.

If `loop.json` defines a smoke command, the loop stops after the smoke-build slice and writes `.handoff/loop/SMOKE-REVIEW.md` plus `.handoff/loop/smoke-approval.json`. Review the smoke output, copy the token from the approval file or the review note, then continue with:

```sh
baton loop run --approve-smoke <token>
```

The token is bound to loop state, smoke command, smoke output, git state, and the child assignment. If anything moved after the review, approval is refused and the run parks for a fresh smoke pass; baton does not spend the full-run budget on stale approval.

Park/resume/escalate behavior is explicit:

| Exit | Meaning | Operator action |
|---:|---|---|
| 0 | Done, or paused cleanly awaiting smoke approval | Continue only if a smoke token is requested |
| 1 | Another live supervisor owns the run lock | Let the live supervisor finish, or recover only after it is provably dead |
| 2 | Usage/config error | Fix `loop.json`, `baton.config.json`, flags, or root selection |
| 3 | Escalated | Read `.handoff/loop/ESCALATION.md`; this file is operator-only, not a prompt for the next child |
| 4 | Parked | Inspect the park reason, then run `baton loop resume` when ready |

A parked run preserves state, logs, and any worktree context for inspection. `baton loop resume` only resumes a parked run; an escalated run needs an operator decision because a review gate hit its cap and baton will not start a hidden sixth attempt.

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
