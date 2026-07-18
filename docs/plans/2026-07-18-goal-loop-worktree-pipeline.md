# Goal-loop + dual-worktree pipeline (Layers 2+3, v1 plan)

Status: DRAFT — Gate-1 pending.

## Context

baton v1 (Layer 1, cross-harness usage-limit failover) is complete: Gate-2
passed, a 40-finding surface audit folded, and the live e2e handoff loop
verified through the real installed plugin. Layers 2 and 3 automate the
development methodology itself on top of that foundation: a goal-driven loop
with review gates (Layer 2) and a dual-worktree adversarial write/review
pipeline (Layer 3).

## Locked decisions (Saksham, 2026-07-18)

1. **Packaging**: inside the baton repo — new commands `baton loop` and
   `baton pipeline`, sharing the role matrix, resolver, doctor, and
   checkpoint/handoff machinery.
2. **Layer 3 swap cadence**: per subtask — writer and reviewer swap seats every
   subtask; Fable plans and performs the final adversarial merge.
3. **Layer 2 smoke gate**: one staged gate after planning — the loop must
   produce a minimal end-to-end slice (build + run + one real assertion) and
   get explicit approval before the full run; the 5-iteration cap governs
   every gate.
4. **Driver**: a supervisor CLI — spawns headless role children
   (`claude -p` / `codex exec`), parses verdicts, and invokes baton handoff
   automatically on limit death. Survives the operator's session ending.

## Design

### Loop spec

`loop.json` at repo root (schema `baton/loop@1`), scaffolded by
`baton loop init "<goal>"`:

- `goal`, `constraints[]` (falsifiable acceptance criteria — the loop's exit
  condition), `smoke` ({cmd, expect} — the staged-gate slice definition),
- `phases` (default: plan → gate-1 → smoke → subtasks (test-author →
  test-verifier → implement → subtask-review) → gate-2 → done),
- `budgets` ({iterationCap: 5, perRoleTimeoutMin, maxChildrenPerPhase}),
- roles resolve through the existing `baton.config.json` matrix — never
  hardcoded models.

### `baton loop` (Layer 2)

- `baton loop init <goal>` — scaffold spec + plan template; idempotent,
  dry-run-able, same two-phase plan/apply discipline as `baton init`.
- `baton loop run [--approve-smoke]` — the state machine. State lives in
  gitignored `.handoff/loop/state.json` + `journal.ndjson` (same atomic
  write + journal replay machinery as the bundle; loop position is also
  checkpointed into the handoff bundle so a limit death carries it).
- Each role invocation is a headless child under the supervisor:
  - claude-code roles: `claude -p "<role prompt>" --permission-mode
    acceptEdits --allowedTools ...` (allowlist per role: reviewers read-only).
  - codex roles: `codex exec -C <root> -s <sandbox> --model <m> -c
    model_reasoning_effort=<e> "<prompt>" </dev/null` (stdin closed — the
    stdin-hang class is a known field failure).
  - Verdict contract: children end with the structured tail
    (`VERDICT: APPROVED|APPROVED_WITH_NOTES|BLOCKED` + FINDINGS) already used
    by every review gate; the supervisor parses exactly that.
- **Smoke gate**: after gate-1, the implementer role builds the smoke slice;
  the supervisor runs `smoke.cmd`, records output, and STOPS with a
  human-readable approval request (`.handoff/loop/SMOKE-REVIEW.md` +
  notification). `baton loop run --approve-smoke` resumes. No full-run budget
  is spent before approval.
- **Limit failover (the baton integration)**: child stderr/exit runs through
  `baton detect`; a usage-limit classification triggers finalize (explicit
  `--reason-class usage-limit`) → resolver picks the role's next chain entry
  (origin platform auto-avoided) → receive on the new platform → child
  relaunched with the resume prompt. All platforms exhausted → the loop
  parks with a resume-at hint instead of dying.
- **Caps**: every gate loops at most 5 iterations; on exhaustion the loop
  parks and escalates (writes `.handoff/loop/ESCALATION.md`, notifies) — never
  a 6th run.

### `baton pipeline` (Layer 3 — a loop preset)

- `baton pipeline run` = `loop run` with the dual-worktree subtask cycle:
  - Two persistent worktrees `.worktrees/wt-a`, `.worktrees/wt-b` (gitignored;
    `git worktree add`), each pinned to its own branch.
  - Subtask N: writer implements on `subtask-N` in one worktree; reviewer
    reviews the diff from the OTHER worktree (fresh checkout, fresh context).
    Seats swap every subtask: Sol writes / Claude reviews → Claude writes /
    Sol reviews → …
  - Verdict flow: APPROVED → the merger role (Fable) adversarially re-checks
    and merges into main (the ONLY writer to main); BLOCKED → writer fixes,
    ≤5 iterations, then escalate. After each merge both worktrees
    fast-forward.
  - Attribution invariant holds everywhere: children commit as
    `SakshamUboweja <ssakshamu@gmail.com>`, zero AI attribution; the existing
    doctor git-guard covers main and both worktree branches.

### Module layout (all under `core/src/loop/`)

`spec.mjs` (load/validate loop.json) · `state.mjs` (state machine +
journal) · `children.mjs` (spawn contract: platform → argv, timeout, verdict
parse, detect-on-exit) · `failover.mjs` (limit death → seal/remap/receive/
relaunch) · `worktrees.mjs` (add/prune/ff, branch discipline) ·
`commands/loop.mjs`, `commands/pipeline.mjs`.

### Acceptance constraints (the loop's exit condition)

1. On a fixture repo, `baton loop run` drives a toy goal end-to-end headlessly:
   plan → gate-1 → smoke slice → parked for approval → (approved) → 2 subtasks
   TDD → gate-2 → done, with review artifacts under `reviews/` in the fixture.
2. Simulated limit death (child exits with a verbatim limit banner) mid-subtask
   → the loop seals, remaps the role off the dead platform, resumes on the
   other harness, and completes the subtask. Chained A→B→A tested.
3. `baton pipeline run` completes 2 subtasks with alternating writer/reviewer
   across the two worktrees; every main-branch commit is authored solely as
   SakshamUboweja with zero AI attribution; reviewer children run read-only.
4. The 5-cap parks + escalates on every gate (unit-forced exhaustion test);
   no gate ever runs a 6th iteration.
5. Deleting `.handoff/` and `.worktrees/` leaves the fixture repo exactly as
   a plain git repo (no residue outside gitignored trees).
6. All existing 878 tests stay green; the new suite covers spec validation,
   state-machine transitions (unit, injected io), child verdict parsing
   (fixture transcripts), failover (fake children), and worktree discipline.

### Top risks

1. **Headless permission surfaces** — Claude Code children need permission
   flags that stay inside the sandboxed repo; reviewers get read-only
   allowlists. Mitigation: per-role allowlist table + spike task 0.
2. **Verdict-parse drift** — models sometimes wrap the tail; parser accepts
   the LAST structured tail in the transcript and treats an unparseable one as
   BLOCKED-with-escalation, never as APPROVED.
3. **Cost runaway** — per-phase child caps + iteration caps + the smoke gate
   before any full-run spend; every child's token/duration logged to the loop
   journal.
4. **Worktree state divergence** — only the merger writes main; workers are
   branch-jailed; ff-sync after each merge; `baton pipeline doctor` checks
   worktree health.
5. **Cross-platform child API drift** — the spawn contract lives in ONE module
   (children.mjs) with per-platform fixtures, same seam discipline as
   normalize.mjs.

## Out of scope for this milestone

Multi-repo loops; parallel subtask fan-out (>1 writer at once); cloud/cron
driving (the supervisor is local-first; scheduled runs are a later layer);
LLM-judged smoke verdicts (the smoke gate is a human gate by decision 3).

## Gate-1 review record

- Iteration 1: pending.
