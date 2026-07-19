# Gate 2 — Milestone B, collated findings (iteration 1)

Reviewer-a: codex/gpt-5.5 @ xhigh (`degraded: model-fallback` from
gpt-5.6-sol) — BLOCKED, 4 blocking / 1 major / 1 minor.
Reviewer-b: claude-code/claude-fable-5 (fresh context) — BLOCKED,
1 blocking / 7 major / 7 minor.

Deduplicated, severity-ordered. Sources: A# = reviewer-a finding, B# =
reviewer-b finding.

## Blocking

- **G1 (A1 + B1 + B2) — Claude children are unusable in production.**
  buildChildArgv's claude-code branch never sets the child cwd (spawns in
  the supervisor cwd — breaks seat isolation and merger-only-main), never
  passes the resolved --model (voids the role matrix + entry avoidance),
  and never requests --output-format json — while parseVerdict requires the
  structured result field, so every real claude child parses as
  BLOCKED-unparseable and gates escalate at the cap.
  Fix: claude argv gains cwd (from opts.root), --model, --output-format
  json; pins in loop-children tests + a default-config pipeline case.

- **G2 (A2 + B3 + B8) — Pipeline preconditions/caps/locking.**
  pipeline run bypasses validateLoopSpec (a spec with iterationCap 6 spawns
  a 6th pair), re-inits state on every invocation (cap refunds across
  re-runs), takes no supervisor run lock (and the loop's lock acquisition
  itself is check-then-write, not atomic), and crashes unhandled on a stale
  subtask branch.
  Fix: clamp/validate cap ≤ 5 before setup; loadLoopState-or-init; atomic
  run-lock acquisition shared with loop run; stale branch → preflight park.

- **G3 (A3 + B4) — Pipeline ignores child results/classification.**
  Writer results are discarded: BLOCKED/limit/timeout/unparseable writers
  proceed to review and can merge empty branches; pipeline never classifies
  any child log and has no failover.
  Fix: classify every child log (as loop run does), route limit classes to
  runFailover, writer BLOCKED → the retry cap, refuse review of an empty
  branch.

- **G4 (A4) — Recovery never adopts in-flight children.**
  superviseChild detaches process groups but nothing records them; a
  supervisor death leaves live children, and lock reclaim neither kills nor
  adopts them.
  Fix: journal child start {pid, pgid} before spawn; on dead-lock reclaim
  kill recorded groups (provably-dead discipline), then continue or park.

## Major

- **G5 (A5 + B5) — Worktree guard composition + reviewer blindness.**
  selfHealWorktree is never called; reviewer seats spawn without preflight;
  a listed-but-raw-deleted worktree crashes git status in a missing cwd;
  claude read-only reviewers (Read,Grep,Glob) cannot run git diff, and the
  subject branch is not checked out in the reviewing seat.
  Fix: self-heal during setup/preflight; preflight reviewer seats; catch
  git preflight errors → park; claude reviewer allowlist gains scoped
  read-only git (diff/log/show); reviewer prompt reviews main..branch via
  git (refs are shared across worktrees).

- **G6 (B6) — Parked runs are terminal.** No CLI path emits RESUME while
  the park/escalation messages instruct resuming.
  Fix: `baton loop resume` (PARKED only; escalation stays operator-only);
  correct the messages.

- **G7 (B7) — Smoke gate keyed to the literal 'smoke-build' id.** A renamed
  phase with smoke.cmd set silently skips the human gate.
  Fix: validateLoopSpec rejects smoke.cmd without a smoke-build phase.

## Minor (notes — recorded, selectively folded)

- G8 (A6 + B9): --detach, probe integration, pipeline smoke gate, findings
  persistence — explicitly recorded as deferred (plan + README note).
- G9 (B10): constraint-1 clauses nominal (no reviews/ artifacts asserted;
  journal events lack phase ids).
- G10 (B11): maxChildrenPerPhase enforced globally, not per phase.
- G11 (B12): codex 'tokens used' marker placement unverified against a live
  transcript.
- G12 (B13): unbounded in-memory child output buffering; classification
  reads the capped log.
- G13 (B14): child logs bypass redaction and the purge walk.
- G14 (B15): hygiene — hardcoded 'main' trunk, to:'claude-code' resolver
  hint, naive smoke.cmd split, stale RED comments in the e2e file.

## Disposition plan

Fold G1–G7 now (tests via the test-author, verifier re-entry, then
implementation); record G8 deferrals in the plan; fold the cheap parts of
G14 (stale comments); carry G9–G13 as documented v1.1 hardening items
unless a reviewer re-raises them as gate-blocking. Re-review by both
reviewers after the fold (iteration 2; cap 5 per reviewer).

# Iteration 2 (post-fold f7960e3) — both reviewers BLOCKED again

Reviewer-a: 2 blocking. Reviewer-b: 1 blocking, 3 major, 4 minor.
Deduplicated:

## Blocking
- **H1 (B1)** — the pipeline WRITER prompt omits the verdict-tail contract
  while the flow requires an APPROVED writer verdict: every real writer
  parses BLOCKED-unparseable and escalates at the cap. Fix: verdict-tail
  block in the writer prompt + a prompt-contract pin.
- **H2 (A1 + B2)** — pipeline failover is unbounded: avoid/avoidEntries
  always [], decision.avoidEntries discarded, and no total child budget —
  dead-model ping-pong loops forever. Fix: per-subtask avoidEntries carry +
  a child-budget guard that parks on exhaustion; always-limit runner pin.
- **H3 (A2 + B5)** — children.ndjson is append-only: completed children are
  never retired, so a dead-lock reclaim kills any live (possibly
  OS-recycled) recorded pgid. Fix: completion records retiring entries when
  a child resolves; reclaim kills only still-active records.

## Major
- **H4 (B3)** — core/bin/baton.mjs never defines io.processKill, so a real
  reclaim skips every kill and then DELETES children.ndjson. Fix:
  process.kill-backed processKill in the bin io; only clear the registry
  after a kill pass with a real killer.
- **H5 (B4)** — loop and pipeline share state.json with no flavor/spec
  binding: cross-flavor resume skips subtasks or reports a false done. Fix:
  stamp {flavor, specDigest} at init; refuse/archive-and-reinit on mismatch.

## Minor (folded where cheap)
- H6 (B6): ESCALATION.md wording still says "resume with baton loop run".
- H7 (B7): a crash between merge and PHASE_ADVANCE resumes into a
  misleading empty-branch park — an already-merged branch should advance.
- H8 (B8b): the lock runId (`sup-<pid>`) is uncorrelated with the state
  runId — cosmetic.
