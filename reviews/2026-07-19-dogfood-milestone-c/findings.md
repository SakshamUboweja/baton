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

## Process note

Dogfood clone is left untouched (parked state preserved as evidence). After
the D-fold lands, re-run the pipeline dogfood from a fresh clone, then the
loop dogfood (smoke-gate flow), then cherry-pick the good README commits.
