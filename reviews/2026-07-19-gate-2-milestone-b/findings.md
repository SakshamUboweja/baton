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

# Iteration 3 (post-fold 64e6cb5) — both reviewers BLOCKED

Reviewer-a: 1 blocking, 1 major, 1 minor. Reviewer-b: 2 major, 3 minor.
All eight H-dispositions audited GENUINE by both. Deduplicated (dual-raised
findings take the higher severity):

## Blocking
- **I1 (A1 + B1)** — the H7 already-merged recognizer false-positives on a
  stale EMPTY branch: `merge-base --is-ancestor` succeeds for a branch
  created by `checkout -b` whose writer never committed (its tip IS an old
  main HEAD), so a crash anywhere in the writer's pre-first-commit window
  makes the resume silently skip the subtask and report it done. Fix:
  auto-advance only on a supervisor-owned merge receipt — journal/persist a
  per-subtask merged record immediately after mergeSubtask succeeds and
  require receipt + is-ancestor; anything else parks as a stale branch. Pin
  the negative: a pre-existing empty branch at main's tip must NOT advance.

## Major
- **I2 (B2)** — retire records mask in-flight children across invocations:
  childSeq resets per run and children.ndjson survives normal acquisitions,
  so a resumed run reuses childIds a prior invocation already retired —
  reclaim's childId-keyed retired set then SKIPS killing the crashed resume
  run's live child (the G4 orphan escape returns in resume-then-crash). Fix:
  truncate children.ndjson on every successful lock acquisition (clean prior
  exit leaves only retired records; a dead owner's records were just
  processed by the reclaim pass). Pin: retire in run 1, same childId
  in-flight in run 2, dead lock → reclaim MUST kill.
- **I3 (A2 + B4)** — unstamped state bypasses the H5 binding: the
  typeof-string guards accept state.json with no flavor/specDigest, so
  pre-stamp (or stripped) state resumes under either command with exactly
  the misalignment H5 prevents. Fix: missing stamp on an EXISTING state =
  mismatch — refuse exit 2 with the archive instruction (no legacy
  population worth grandfathering); reconcile older recovery fixtures that
  seed unstamped states.

## Minor
- **I4 (A3 + B3)** — the loop-side H5 refusals return after
  acquireSupervisorLock but before the releasing try/finally, leaking
  supervisor.lock (pipeline's equivalents are correctly inside its finally).
  Fix: run the flavor/specDigest checks inside the released region (or
  before acquiring).
- **I5 (B5)** — acquireSupervisorLock calls io.processAlive(other.pid)
  without the recorded startTime, so a recycled pid reads as a live
  supervisor and wedges the lock until hand-deleted. Fix: pass
  other.startTime so pid-reuse verification engages.

## Disposition plan
Fold all five now (I4/I5 are one-line-cheap; I1–I3 sit on the crash/recovery
acceptance constraint). TDD flow: test-author pins → verifier → implement →
Gate-2 iteration 4 (cap 5, both reviewers at 3).

# Iteration 4 (post-fold c986afb) — reviewer-a APPROVED; reviewer-b BLOCKED

Reviewer-a: APPROVED, zero findings (all I-dispositions verified; typecheck
+ targeted suites green in its sandbox). Reviewer-b: BLOCKED, 1 major +
1 minor, both in the fold's own recovery flow; all five I-dispositions
audited GENUINE. Iteration 5 is reviewer-b-only (re-review by the raising
reviewer) and FINAL under the 5-cap.

## Major
- **J1 (B1)** — every pipeline park is terminal: `baton pipeline` has no
  resume subcommand, drivePipeline refuses PARKED unconditionally, and
  `baton loop resume` refuses flavor 'pipeline' — yet the I1a stale-branch
  park instructs "delete the branch and resume", and the documented
  fallback (archive .handoff/loop) discards merges.ndjson, so surviving
  merged branches re-park as stale and a re-init refunds G2's cap counters.
  Fix: `baton pipeline resume` (PARKED-only RESUME transition,
  flavor-guarded, mirroring G6's loop resume); correct the I1a message; pin
  park → resume → the same subtask re-runs with cap counters intact.

## Minor
- **J2 (B2)** — a crash between mergeSubtask succeeding and the receipt
  append resumes into the I1a park whose message misdiagnoses merged work
  as "a writer likely crashed before committing", and whose "delete the
  branch" step fails while the branch is checked out in the writer's seat.
  Fix: hedge the message (pre-commit crash OR merged-without-receipt;
  point the operator at `git log main..<branch>`) and include the
  seat-checkout step in the remediation.

## Disposition plan
Fold both now (J1 via TDD pins; J2 rides along as message/remediation
wording pinned in the same pass). Then reviewer-b iteration 5 — FINAL: any
iteration-5 BLOCK hard-stops the gate and escalates the outstanding
findings to Saksham per the 5-cap rule.
