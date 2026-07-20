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

## baton pipeline

`baton pipeline run` is the dual-worktree preset over the loop engine. It takes a list of subtasks from `loop.json` and runs each one through a writer → reviewer → merger cycle across two isolated git worktrees, merging into `main` only after two independent read-only checks pass.

Quickstart:

```sh
baton loop init "<goal>"
# edit loop.json: add a subtasks array — [{"id": "auth", "title": "…"}, …]
baton pipeline run
```

On first run baton creates two worktree seats, `.worktrees/wt-a` and `.worktrees/wt-b`, and gitignores `.worktrees/`. Subtasks alternate seats (first subtask → wt-a, second → wt-b, and so on), and each subtask flows through four steps:

1. **Write** — the seat's worker gets branch `baton/wt-<seat>/subtask-<id>` checked out in its own worktree and commits its work there.
2. **Review** — a read-only child runs under the `subtask-reviewer` role from the *other* seat, using that seat's worker model: fresh context, different model, diffing the branch against `main`.
3. **Merge check** — a read-only `merger` child adversarially re-checks the branch.
4. **Merge** — the supervisor itself (never a child) merges into `main` behind a merge lock and an attribution scan, then fast-forwards both seats. A merge conflict aborts and parks; baton never auto-resolves one.

Every verdict is `APPROVED` / `APPROVED_WITH_NOTES` / `BLOCKED`. A BLOCKED verdict sends its findings back to the writer for another attempt; each subtask's review gate carries the same hard 5-iteration cap, and hitting it escalates. A child that dies (usage limit, crash) is never treated as a verdict — it routes through role failover, bounded by the role's chain length, and only a real verdict reaches the gate. An empty branch (no commits ahead of `main`) parks instead of merging.

What it needs:

- **`loop.json`** with a `goal` and a non-empty `subtasks` array of `{id, title}` objects. Ids must be unique — they name the branches. Optional: `budgets.iterationCap` (1–5) and `budgets.perRoleTimeoutMin`.
- **Roles in `baton.config.json`:**

| Role | Used for |
|---|---|
| `worker-a` | writer for seat wt-a (1st, 3rd, … subtask) |
| `worker-b` | writer for seat wt-b (2nd, 4th, … subtask) |
| `subtask-reviewer` | the role reviewer children run under (the model comes from the opposite seat's worker chain) |
| `merger` | the read-only pre-merge adversarial check |

Merges are crash-safe. Each merged subtask appends a receipt to `.handoff/loop/merges.ndjson` *before* the run's position advances, so a crash between merge and advance resumes into a receipt-backed skip instead of re-running merged work. Exit codes match the `baton loop` table above.

### Resuming a parked run

A run *parks* (exit 4) when it can't safely continue on its own — a phase exhausts its child budget, no eligible model resolves for a role, failover runs out of platforms, or a smoke-approval token drifted; a pipeline also parks on a merge conflict or an empty subtask branch. Parking preserves state, child logs, and worktree context under `.handoff/loop/`, so you can inspect the reason before continuing.

`baton loop resume` (or `baton pipeline resume`) picks a parked run back up from where it stopped, without refunding any review gate's iteration count. It handles two cases deliberately:

- **Escalated runs are operator-only.** Escalation means a review gate hit its hard 5-iteration cap, so resume refuses (exit 3) and points at `.handoff/loop/ESCALATION.md`. Resolve the findings and start a fresh gate yourself; baton will not open a hidden sixth attempt.
- **Stale or absent state is refused, not guessed.** Resuming with no run state here ("nothing to resume") is treated as a wrong-directory mistake. A run whose `loop.json` phases or `subtasks` list changed since it started — or a `loop` run resumed as a `pipeline`, or vice versa — is rejected rather than misaligned; archive `.handoff/loop/` to start fresh.

A plain `baton loop run` (or `baton pipeline run`) on an already-parked run reports the park and exits 4 without resuming — use `resume` to continue.

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
