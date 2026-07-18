# Goal-loop + dual-worktree pipeline (Layers 2+3, v1 plan)

Status: APPROVED — Gate 1 passed at iteration 4 of 5 (2026-07-18,
codex/gpt-5.5 @ xhigh, `degraded: model-fallback`).

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
2. **Layer 3 swap cadence**: per subtask — writer and reviewer swap seats
   every subtask; the planner role plans and the merger role performs the
   final adversarial merge (concrete chains live in `baton.config.json`).
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
- `phases` — an ordered list of `{id, role}` entries: `id` is a free label
  for progress display; `role` MUST be a matrix role ID (validation fails on
  any unknown role before a child spawns). Default:
  plan(`planner`) → gate-1(`plan-reviewer`) → smoke — itself a TDD mini-cycle
  per the repo contract: smoke-tests(`test-author`) →
  smoke-verify(`test-verifier`) → smoke-build(`implementer`) → the human
  smoke gate — → per-subtask cycle (`test-author` → `test-verifier` →
  `implementer` → `subtask-reviewer`) → gate-2(`final-reviewer-a`,
  `final-reviewer-b`) → done,
- `budgets` ({iterationCap: 5, perRoleTimeoutMin, maxChildrenPerPhase}),
- roles resolve through the existing `baton.config.json` matrix — never
  hardcoded models.

### Role-matrix additions (Gate-1 iteration 1, finding 1)

The loop references roles by ID only; every referenced role must exist in the
matrix or `loop.json` validation fails (`unknown role '<id>'`, exit 2, before
any child spawns). Four roles are ADDED to `baton.config.json` +
`templates/baton.config.json.tpl` in the first implementation task:

- `subtask-reviewer` — per-subtask diff review inside the loop cycle.
- `merger` — the only role that writes main in pipeline mode; adversarial
  re-check before merge.
- `worker-a`, `worker-b` — the two pipeline seats. Subtask N assigns
  writer = seat (N mod 2), reviewer = the other seat; the SEATS swap, and each
  seat's concrete platform/model comes from its configured chain via the
  resolver. No vendor or model name appears in this plan, child prompts, or
  loop code — chains live in config only.

### `baton loop` (Layer 2)

- `baton loop init <goal>` — scaffold spec + plan template; idempotent,
  dry-run-able, same two-phase plan/apply discipline as `baton init`.
- `baton loop run [--approve-smoke <token>]` — the state machine. State lives
  in gitignored `.handoff/loop/state.json` + `journal.ndjson` (same atomic
  write + journal replay machinery as the bundle; loop position is also
  checkpointed into the handoff bundle so a limit death carries it).

### Root + ownership discipline (Gate-1 iteration 1, finding 2)

One authoritative root: the MAIN repo root where `loop.json` lives. The
supervisor is the SOLE writer of `.handoff/loop/` and of the main root's
handoff bundle; every supervisor-driven baton invocation passes explicit
`--root <mainRoot>` and a supervisor-owned stable session hint
(`--session loop-<runId>` — a NEW flag added to `checkpoint`; `receive`
already has it), so the bundle has exactly one stable owner.

**Child-hook policy (Gate-1 iteration 2, finding 1; iteration 3,
finding 1)** — children never touch OR read any bundle, by construction: the
supervisor sets `BATON_SUPERVISED_CHILD=1` in every child's environment, and
EVERY baton hook command — the hook entrypoints, `baton checkpoint`, and
`baton session-start` (which would otherwise read the bundle and inject
pending-handoff resume context into the child) — quietly no-ops (exit 0,
empty output) when it is set. This covers
Layer-2 children running in the MAIN root (where root discovery would
otherwise find the supervisor-owned bundle and the foreign-session guard
would reject their stable hints) and pipeline children in worktrees alike;
narrative checkpointing for supervised work is the supervisor's job, driven
by parsed child results. Contract tests: (a) Layer-2 — two concurrent
main-root children with distinct stable session hints and live hooks →
zero bundle mutations, zero foreign-session rejections, supervisor
`--session` checkpoints land; (b) pipeline — same from two worktrees while
the supervisor writes loop state.
- Each role invocation is a headless child under the supervisor:
  - claude-code roles: `claude -p "<role prompt>" --permission-mode
    acceptEdits --allowedTools ...` (allowlist per role: reviewers read-only).
  - codex roles: `codex exec -C <root> -s <sandbox> --model <m> -c
    model_reasoning_effort=<e> "<prompt>" </dev/null` (stdin closed — the
    stdin-hang class is a known field failure).
  - Verdict contract: children end with the structured tail
    (`VERDICT: APPROVED|APPROVED_WITH_NOTES|BLOCKED` + FINDINGS) already used
    by every review gate; the supervisor parses exactly that.

### Child supervision contract (Gate-1 iteration 1, finding 7)

`children.mjs` owns the full child lifecycle, not just argv assembly:

- Spawn detached in its OWN process group; stdin closed at spawn (the
  codex-exec stdin-hang class); per-role timeout → SIGTERM to the group, 10 s
  grace, then SIGKILL to the group (no zombie grandchildren; reap verified in
  tests with a child that forks a sleeper).
- Full child output streams to `.handoff/loop/children/<child-id>.log` with a
  byte cap (head preserved, middle truncated with a marker — the verdict tail
  is at the END so the tail is never truncated).
- **Verdict parsing is region-bounded (prompt-echo defense)**: only the
  child's FINAL message region is parsed — claude-code children run with a
  structured output format and the parser reads the result field; codex
  children are parsed strictly AFTER the last `tokens used` marker. The
  prompt region (which quotes `VERDICT:` in its instructions) is never
  scanned. Multiple tails in the final region → the LAST one wins.
- An unparseable, absent, or truncated verdict is BLOCKED-with-escalation,
  never APPROVED; a child that exits after making edits but before a verdict
  parks the subtask with its worktree preserved for inspection.
- A generic nonzero exit classifies as `other-error` (existing classifier
  rule) → the loop retries once, then parks; it NEVER triggers limit failover
  without limit-specific evidence.
- Fixture-driven tests: prompt echo, multiple verdict tails, truncated
  transcript, timeout kill/reap, zombie grandchild, non-limit nonzero exit.

### Supervisor lifetime and recovery (Gate-1 iteration 2, finding 5)

"Survives the operator's session ending" is a defined mechanism, not a hope:

- `baton loop run` is FOREGROUND by default. `--detach` re-launches the
  supervisor in its own session (`setsid`), output to
  `.handoff/loop/supervisor.log`, and returns.
- A run lock `.handoff/loop/supervisor.lock` carries {pid, process
  start-time, host, runId} — the same provably-dead machinery as the
  Layer-1 bundle lock. A second `loop run` against a LIVE supervisor is
  refused; against a provably-dead one it recovers.
- The state machine is journal-replayable: recovery replays
  `journal.ndjson`, marks any in-flight child of the dead supervisor as
  interrupted (its process group is gone or killed on adoption), and either
  continues from the last completed step or parks with an escalation note —
  never re-runs a completed gate iteration.
- Acceptance adds a supervisor-death test: kill the supervisor (and its
  launching session) mid-subtask → a fresh `loop run` recovers via the
  journal and continues or parks; no orphaned children survive (process
  groups reaped on adoption).

- **Smoke gate (staleness-proof — Gate-1 iteration 1, finding 8; TDD order —
  iteration 2, finding 2)**: after gate-1, the smoke slice is built as a TDD
  mini-cycle (test-author writes the failing smoke assertion → test-verifier
  approves it → implementer writes only enough to pass it — the repo TDD
  contract applies to the slice, not just to subtasks); the supervisor then
  runs `smoke.cmd`, records output, and STOPS, writing
  `.handoff/loop/SMOKE-REVIEW.md` plus `smoke-approval.json` containing an
  approval token = digest over {loop-state digest, smoke.cmd, output digest,
  HEAD, content-sensitive git digest (existing snapshot machinery), child
  assignment}. Resuming requires `baton loop run --approve-smoke <token>`;
  the supervisor recomputes the digest first and REFUSES a drifted token
  (anything changed since the human looked) — it parks for a fresh smoke run
  instead. No full-run budget is spent before a valid approval.
- **Limit failover (the baton integration — Gate-1 iteration 1, finding 3)**:
  an exact transaction, not a loose chain. On child death: (1) reap the
  process group and freeze the transcript; (2) classify via `baton detect`;
  non-limit → the retry/park path above. On a limit classification:
  (3) checkpoint the loop position INTO THE BUNDLE (supervisor
  `checkpoint --session loop-<runId>`) so the seal carries it and the receipt
  token binds it; (4) seal via `finalize --reason-class usage-limit --root
  <mainRoot>` (an already-dead/unsealed bundle takes the degraded-open path
  receive already supports); (5) refresh probes; (6) `receive --prepare` then
  `--commit` back-to-back with IDENTICAL intake flags, the supervisor session
  hint, and the same explicit root, with NO intervening writes; (7) resolver
  output (with the dead entry avoided) picks the relaunch platform+model;
  (8) relaunch the child with the resume prompt. A stale-token rejection
  triggers ONE automatic re-prepare/commit retry; a second failure parks.
  Between prepare and commit the failover holds the loop transaction lock and
  writes NOTHING — `.handoff/loop/` writes are not token-bound inputs, so
  this is enforced by construction and ASSERTED in tests (fs spy: zero
  `.handoff/loop/` writes inside the window), not assumed. Drift-rejection
  tests inject the inputs the token actually binds: git change and probe
  refresh between prepare and commit → stale-token → one retry path. Plus:
  open-bundle (unsealed) limit death; the full seal→receive→relaunch happy
  path.
- **Model-level failover (Gate-1 iteration 1, finding 4)**: the resolver
  gains entry-level avoidance — `avoidEntries: [{platform, model}]` alongside
  the existing platform-level `avoid[]` — and the classifier gains a
  `model-unavailable` signature class (distinct from usage-limit; seeded with
  the verified account-tier rejection string). A model rejected at spawn adds
  its {platform, model} entry to avoidEntries and re-resolves: other models
  on the SAME platform remain selectable. Named test: first chain entry
  rejected as model-unavailable → the next entry on the same platform is
  selected, with no platform-wide avoidance.
  All platforms/entries exhausted → the loop parks with a resume-at hint
  instead of dying.
- **Caps**: every gate loops at most 5 iterations; on exhaustion the loop
  parks and escalates (writes `.handoff/loop/ESCALATION.md`, notifies) — never
  a 6th run.

### `baton pipeline` (Layer 3 — a loop preset)

- `baton pipeline run` = `loop run` with the dual-worktree subtask cycle:
  - Two persistent worktrees `.worktrees/wt-a`, `.worktrees/wt-b`
    (`git worktree add`); `pipeline init` ensure-lines `.worktrees/` into
    `.gitignore` (same idempotent machinery as the `.handoff/` line).
  - Subtask N: the writer seat implements on a namespaced branch
    (`baton/wt-<seat>/subtask-N`) in its worktree; the reviewer seat reviews
    the diff from the OTHER worktree (fresh checkout, fresh context). Seats
    swap every subtask: worker-a writes / worker-b reviews → worker-b writes /
    worker-a reviews → … (concrete models per seat come from the role
    matrix — see Role-matrix additions).
  - Verdict flow: APPROVED → the merger role adversarially re-checks and
    merges into main (the ONLY writer to main); BLOCKED → writer fixes,
    ≤5 iterations, then escalate. After each merge both worktrees
    fast-forward.

  **Worktree transaction layer (Gate-1 iteration 1, finding 5)** —
  `worktrees.mjs` treats every git operation as a guarded transaction:
  - Branch namespace `baton/wt-*/…` is loop-owned; anything else is never
    touched.
  - Preflight before each child: worktree exists in `git worktree list`,
    index clean, HEAD on the expected branch — a dirty or drifted worktree
    parks the subtask instead of spawning.
  - Postflight after each child: HEAD still on the expected branch, main
    unmoved by the child — violation parks with the evidence.
  - Merges run under a supervisor-held merge lock; worktree sync after merge
    is ff-only (a non-ff sync is a corruption signal → park); merge conflicts
    park + escalate, never auto-resolved.
  - Stale metadata self-heals: a raw-deleted worktree directory is detected
    (`git worktree list` vs fs), pruned (`git worktree prune`), and re-added;
    teardown uses `git worktree remove` + branch deletion so acceptance
    constraint 5 (no residue) holds.
  - Adversarial tests: stale branch from a previous run, dirty worker,
    main moved mid-subtask, merge conflict, raw-deleted `.worktrees/`,
    untracked `.worktrees/` (missing gitignore line → doctor check).

  **Attribution enforcement for child commits (Gate-1 iteration 1,
  finding 6)** — the invariant is enforced, not assumed:
  - The supervisor sets `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL`
    (sole author identity) in EVERY child's environment.
  - Every merge is gated on an attribution scan over the exact range
    `main..baton/wt-<seat>/subtask-N` — author/committer identity plus the
    forbidden-trailer patterns (the existing doctor patterns, applied to the
    full range, not a last-50 window). A violation blocks the merge and
    parks.
  - The existing doctor 50-commit scan remains the repo-wide backstop.

### Module layout (all under `core/src/loop/`)

`spec.mjs` (load/validate loop.json incl. role-existence check) · `state.mjs`
(state machine + journal + smoke-approval token) · `children.mjs` (full child
lifecycle: spawn/process-group/timeout/log-cap, region-bounded verdict parse,
detect-on-exit) · `failover.mjs` (the limit-death transaction) ·
`worktrees.mjs` (guarded git transactions, branch discipline, attribution
range scan) · `commands/loop.mjs`, `commands/pipeline.mjs`. Plus three Layer-1
extensions: `roles/resolve.mjs` gains `avoidEntries[]` (entry-level
avoidance, backward-compatible — omitted means current behavior); the
signature table gains the `model-unavailable` class; `checkpoint` gains a
`--session <hint>` flag (supervisor identity), and the
`BATON_SUPERVISED_CHILD` no-op guard lands in the hook entrypoints,
`checkpoint`, AND `session-start` (every hook-invoked command).

### Acceptance constraints (the loop's exit condition)

1. On a fixture repo, `baton loop run` drives a toy goal end-to-end headlessly:
   plan → gate-1 → smoke slice AS A TDD MINI-CYCLE (failing smoke assertion
   authored and verifier-approved BEFORE the slice implementation — order
   asserted from the journal) → parked for approval → (approved) → 2 subtasks
   TDD → gate-2 → done, with review artifacts under `reviews/` in the fixture.
   Layer-2 children run in the main root with live hooks and neither mutate
   NOR read the supervisor-owned bundle: under `BATON_SUPERVISED_CHILD=1`,
   hook commands on all three platforms produce zero bundle writes AND zero
   session-start resume context (both asserted).
2. Simulated limit death (child exits with a verbatim limit banner) mid-subtask
   → the loop seals, remaps the role off the dead platform, resumes on the
   other harness, and completes the subtask. Chained A→B→A tested. Separately:
   a model-unavailable rejection at spawn selects the NEXT entry on the same
   platform (no platform-wide avoidance).
3. `baton pipeline run` completes 2 subtasks with alternating writer/reviewer
   across the two worktrees; the attribution range scan passes for main AND
   both worker branch ranges (child commits included) — sole author, zero AI
   attribution; reviewer children run read-only.
4. The 5-cap parks + escalates on every gate (unit-forced exhaustion test);
   no gate ever runs a 6th iteration. Killing the supervisor (and its
   launching session) mid-subtask → a fresh `loop run` recovers via the
   journal and continues or parks, with no orphaned children.
5. Deleting `.handoff/` and `.worktrees/` leaves the fixture repo exactly as
   a plain git repo (no residue outside gitignored trees).
6. All existing 878 tests stay green; the new suite covers spec validation,
   state-machine transitions (unit, injected io), child verdict parsing
   (fixture transcripts), failover (fake children), and worktree discipline.

### Top risks

1. **Headless permission surfaces** — Claude Code children need permission
   flags that stay inside the sandboxed repo; reviewers get read-only
   allowlists. Mitigation: per-role allowlist table + spike task 0.
2. **Verdict-parse drift** — models sometimes wrap the tail; the
   region-bounded parser (Child supervision contract) takes the LAST tail in
   the final-message region only and treats an unparseable one as
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

- **Iteration 1** (2026-07-18, codex/gpt-5.5 @ xhigh, read-only `codex exec`;
  `degraded: model-fallback` — the configured plan-reviewer lead model is
  account-tier rejected as of 2026-07-18): **BLOCKED** — 4 blocking, 4 major.
  Disposition:

| # | Finding | Disposition |
|---|---|---|
| 1 | Roles `subtask-review`/`merger` unresolved; models hardcoded in plan | Fixed — four role IDs (`subtask-reviewer`, `merger`, `worker-a`, `worker-b`) added to the matrix; spec validation fails on unknown roles; vendor/model names removed from the plan |
| 2 | Loop state vs root discovery + one-active-session semantics | Fixed — Root + ownership discipline section: supervisor sole writer with explicit `--root` + `loop-<runId>` session; child-hook checkpoints isolated per worktree; concurrent two-worktree contract test |
| 3 | Failover chain underspecified vs receive transaction | Fixed — exact 8-step transaction; prepare+commit back-to-back with identical flags and no intervening writes; one bounded re-prepare retry; per-drift-source tests |
| 4 | Resolver can't avoid a single model entry | Fixed — `avoidEntries[]` + `model-unavailable` signature class; same-platform-next-entry named test |
| 5 | Worktree discipline lacks corruption guards | Fixed — worktrees.mjs guarded-transaction layer: namespaced branches, pre/postflight assertions, merge lock, ff-only sync, conflict parking, prune self-heal, `.gitignore` ensure-line, adversarial tests |
| 6 | Attribution not enforced for child worktree commits | Fixed — GIT_AUTHOR_*/GIT_COMMITTER_* set on every child; merge gated on full-range attribution scan; acceptance constraint 3 strengthened |
| 7 | Spawn/verdict contract too weak | Fixed — Child supervision contract: process groups, SIGTERM→SIGKILL, capped logs, region-bounded verdict parse with prompt-echo defense, unparseable→BLOCKED, fixture tests |
| 8 | Smoke gate can approve stale state | Fixed — digest-bound approval token in `smoke-approval.json`; `--approve-smoke <token>` revalidated before resume; drift parks for a fresh smoke run |

- **Iteration 2** (2026-07-18, codex/gpt-5.5 @ xhigh, `degraded:
  model-fallback`): **BLOCKED** — 2 blocking, 3 major; iteration-1 findings
  3/5/6/8 explicitly accepted as dispositioned. Disposition:

| # | Finding | Disposition |
|---|---|---|
| 1 | Layer-2 main-root children still collide with the owned bundle; `--session` doesn't exist on checkpoint | Fixed — `BATON_SUPERVISED_CHILD` no-op guard on hooks + checkpoint (children never touch any bundle); `checkpoint --session` added for the supervisor; main-root concurrent-child contract test added |
| 2 | Smoke phase violates the TDD contract | Fixed — smoke slice is a TDD mini-cycle (failing assertion → verifier approval → minimal implementation); phase order + acceptance constraint 1 assert it from the journal |
| 3 | Phase IDs vs role IDs ambiguous | Fixed — phases are `{id, role}`; `role` must be a matrix role ID, validated before any spawn; default spec uses exact role IDs |
| 4 | Loop-state drift test unfalsifiable (not a token input) | Fixed — no-write window enforced by the loop transaction lock and ASSERTED via fs spy; drift tests inject only token-bound inputs (git, probes); loop position checkpointed into the bundle pre-seal so the token binds it |
| 5 | "Survives operator session ending" untestable | Fixed — Supervisor lifetime and recovery section: foreground default + `--detach`, provably-dead run lock, journal-replay recovery, supervisor-death acceptance test |

- **Iteration 3** (2026-07-18, codex/gpt-5.5 @ xhigh, `degraded:
  model-fallback`): **BLOCKED** — 1 blocking, 1 minor; iteration-2 findings
  2–5 explicitly accepted as dispositioned. Disposition:

| # | Finding | Disposition |
|---|---|---|
| 1 | Supervised-child guard misses `session-start` (bundle read + resume-context injection into children) | Fixed — `BATON_SUPERVISED_CHILD` no-ops EVERY hook-invoked command incl. `session-start`; acceptance constraint 1 asserts zero writes AND zero resume context on all three platforms |
| 2 | Stale concrete model name in locked decision 2 | Fixed — reworded to planner/merger roles with chains in config |

- **Iteration 4 — FINAL** (2026-07-18, codex/gpt-5.5 @ xhigh, `degraded:
  model-fallback`): **APPROVED**, zero findings. Both iteration-3
  dispositions verified against adapter/core code; regression scan found no
  new implementation-start blocker; iterations 1–3 stand dispositioned.
  Gate 1 closed at iteration 4 of 5 under the cap.
