# Milestone C — live dogfood findings (pipeline run 1)

Setup: clone of baton@09e6264 at ~/baton-dogfood; `baton pipeline run` with two
real README subtasks; real children (codex worker-a, claude worker-b),
iterationCap 3, 15-min role timeout. Outcome: PARKED on subtask 'doc-loop',
exit 4. Evidence: the clone's .handoff/loop/ (children/001+002 logs,
state.json) and the supervisor stdout.

## What worked live

- Entry-level failover: the sol child died on the account-tier rejection
  (children/001) and relaunched on codex/gpt-5.5, which produced a correct
  README section (children/002) — the model-unavailable → avoidEntries →
  relaunch path is proven outside fakes.
- Park semantics: the run parked (not crashed/looped) with a recorded reason,
  and state.json is resumable.

## Findings (fold via TDD in the real repo)

- **D1 (critical) — transcript classification false-positives on the child's
  own work product.** classify() reads the whole capped log; child 002's
  README diff *documents* usage-limit failover, so a healthy exit-0
  APPROVED-verdict child matched a usage-limit signature and was routed into
  the usage-limit failover (platform-avoid → all-codex chain dead → park).
  Fix: classify only the transcript TAIL (bounded, e.g. last 4 KB) at the
  loop/pipeline call sites — death banners sit at the end of a log; a diff
  hunk in the body must not classify.
- **D2 (critical) — codex writers cannot commit in a linked worktree.** The
  `codex exec -s workspace-write` sandbox roots at the seat cwd
  (.worktrees/wt-<seat>), but a linked worktree's git metadata (index, lock)
  lives under the MAIN repo's .git/worktrees/<seat>/ — outside the sandbox.
  Child 002: "sandbox only has read access to .git/worktrees/wt-a/index.lock";
  work left uncommitted, verdict BLOCKED. Fix: buildChildArgv (codex,
  write-capable role) adds the main repo's .git directory as an extra
  writable root (`-c sandbox_workspace_write.writable_roots=[...]`) — the
  pipeline passes the main root alongside the seat cwd.
- **D3 (major) — the failover checkpoint collides with the operator's
  bundle.** The clone's active bundle belonged to the operator session (hook
  checkpoints); the failover transaction's `checkpoint --session <hint>` was
  rejected as foreign, and the subsequent seal proceeded against a bundle the
  run does not own. Fix: the supervised failover transaction takes over the
  repo bundle explicitly (--take-over semantics: archive the operator bundle,
  open the run's own generation) so the seal/receive chain acts on state it
  owns.
- **D4 (major) — a plain BLOCKED writer retry re-resolves from the original
  chain, ignoring entries already avoided by failover.** After the sol →
  gpt-5.5 relaunch, a later BLOCKED retry resets forcedWriter to the
  original resolveOne('worker-a') result — sol again. subtaskAvoidEntries
  must feed every writer resolution for the subtask, not only runFailover.
- **D5 (minor) — sessionHints double-prefix.** runId is already
  'loop-<hex>'; loop.mjs and pipeline.mjs both build sessionHint as
  `loop-${runId}` → 'loop-loop-<hex>'. Use the runId itself.

## Attempt 2 (post-D-fold 728020d, clone ~/baton-dogfood-2) — exit 3

PROOF: subtask doc-loop completed the ENTIRE live cycle — sol death →
gpt-5.5 failover → committed writer work (D2 grant held) → substantive
Fable review (verified README claims against the code, APPROVED_WITH_NOTES)
→ Fable merge-check → supervisor merge with receipt → sole-author commit
9c05a8b on the clone's main. Subtask doc-pipeline escalated at the cap with
EMPTY findings. New findings:

- **D6 (major) — reviewer/merger children get no classification or
  failover.** The subtask-reviewer inherits the other seat's worker chain;
  for doc-pipeline that head is sol → the reviewer died on the account
  rejection three times (children/006/008/010), each unparseable death
  counted as a BLOCKED review, burning the whole gate cap. Only writers got
  the G3 classify→failover path. Fix: classify reviewer and merger logs
  (tail) exactly like writers; a failure-class death re-resolves the role
  with the subtask's avoidEntries (model-unavailable → entry-avoid) instead
  of consuming a gate iteration; park on chain exhaustion.
- **D7 (major) — the pipeline's escalation is not persisted.** The
  synthesized state spec omits budgets, so the reducer escalates at its
  default cap (5) while drivePipeline enforces the spec cap (3) up top —
  the run exited 3 with state.json still status 'running', escalation null,
  counter at 4 (live artifact). A later resume would see a running state.
  Fix: carry the effective iterationCap into initLoopState's spec so the
  reducer's escalation threshold equals the enforced cap and the escalated
  status persists.
- **D8 (minor) — ESCALATION.md can be empty.** Unparseable child deaths
  leave findings '' and the operator gets a blank escalation. Fix: when
  findings are empty, include the last child's log tail (bounded) in
  ESCALATION.md.

## Outcome — MILESTONE C CLOSED (2026-07-20)

- **Attempt 3 (clone ~/baton-dogfood-3, post-D6-D8 fold eb5ac44): FULL PASS,
  exit 0.** Both README subtasks merged with receipts and sole-author
  commits; the doc-pipeline reviewer died once on sol and failed over live
  to gpt-5.5 (children/006 → 007) — the D6 path proven in production.
- **Loop dogfood (same clone): FULL PASS.** Dead-lock reclaim fired live
  ("reclaimed the run lock from a provably-dead supervisor"); planner +
  implementer ran; the implementer shipped a real `-v` alias with tests
  (verified: `baton --version` → 0.2.0); the smoke gate stopped the run
  with a faithful SMOKE-REVIEW.md; the bound token approved and the run
  completed exit 0.
- README docs authored BY the pipeline cherry-picked to the real repo
  (66edc7b, b6b6f84); suite 1209/1209 green after.
- **D9 (minor, deferred to v1.1):** after a smoke-approve resume completes
  the final phase, the persisted status stays 'running' instead of 'done'
  (the DONE flip from the pre-smoke PHASE_ADVANCE is overwritten by
  SMOKE_AWAIT → SMOKE_APPROVE leaves RUNNING; the completion path prints
  done and exits 0 without a final transition). Benign — re-runs print done
  — but the artifact misdescribes a finished run.

Eight findings (D1–D8) were found ONLY by live dogfooding — none surfaced
in 1200+ tests or two Gate-2 reviews. Evidence clones: ~/baton-dogfood
(attempt 1, parked), ~/baton-dogfood-2 (attempt 2, escalated),
~/baton-dogfood-3 (attempt 3 + loop, both done).

## Process note

Dogfood clone is left untouched (parked state preserved as evidence). After
the D-fold lands, re-run the pipeline dogfood from a fresh clone, then the
loop dogfood (smoke-gate flow), then cherry-pick the good README commits.
