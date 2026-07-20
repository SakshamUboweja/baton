# Changelog

Notable changes to baton, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are milestone markers from `docs/plans/`, not npm releases — the npm publish lands with Milestone E.

## v1.1 — 2026-07-20

Hardening (Milestone D): close every deferral from the v1.0 gates without changing shipped contracts.

- D9 done-status: a smoke-approved resume that completes the final phase now persists status `done` instead of leaving `running`.
- Trunk derivation: the pipeline derives the repo's default branch at setup and persists it in run state — master-trunk repos work end-to-end, nothing hardcodes `main`.
- Per-phase child budgets: `budgets.maxChildrenPerPhase` is enforced per phase/subtask rather than as a global product; an exhausted phase parks naming that phase.
- Findings persistence: gate findings append to `.handoff/loop/findings/<gate>.ndjson`, so a resumed or restarted run re-prompts the writer with the prior findings instead of an empty string.
- Review artifacts: each gate child's prompt and verdict are written under `reviews/<runId>/<gate>/iteration-NN/`, fail-open so artifact writes never block the run.
- Streaming log caps: child output streams to the capped log during capture, keeping supervisor memory bounded against runaway children.
- Child-log redaction + purge: child logs under `.handoff/loop/children/` pass through the secret-redaction filter, and `baton purge-transcript` covers the loop tree.
- Live codex fixture: a real codex transcript is committed as a fixture pinning verdict parsing and tail classification against observed output.
- Probe-aware resolution: `loop run` / `pipeline run` feed the doctor's cached availability probes into role resolution, skipping rate-limited platforms at first spawn and on every failover relaunch (stale probes over 15 minutes are ignored; offline stays degraded, never blocked).
- Pipeline smoke gate: optional `smoke.cmd` for pipelines — after the final subtask merges, the run pauses for the same drift-bound token approval the loop uses.
- `--detach`: `baton loop run --detach` and `baton pipeline run --detach` fork the supervisor into a background process group that survives the terminal, logging to a capped `.handoff/loop/supervisor.out` (POSIX; Windows unsupported in v1.1).

## v1.0 — 2026-07-11 to 2026-07-20

The usage-limit failover core, built TDD behind two review gates and proven in live dogfood runs.

- Zero-dependency Node CLI (`checkpoint`, `finalize`, `detect`, `remap`, `receive`, `init`, `doctor`, `status`, `purge-transcript`, `recover`, `session-start`) with a JSON envelope contract.
- Hook-driven checkpoints into a gitignored `.handoff/` bundle, an explicit handoff seal, and a receive flow that remaps model roles from `baton.config.json` and continues the task on the destination platform.
- Limit-death detection via structured signals (Claude Code `StopFailure`) plus versioned text signatures for the other harnesses.
- Adapters for Claude Code (plugin), Codex CLI, and Cursor, plus scaffolded `AGENTS.md` / `CLAUDE.md` templates.
- `baton loop`: a goal supervisor running a repo-local `loop.json` plan through headless writer and reviewer roles, with journal-replayable state, a hard 5-iteration review cap, smoke-token approval, and park/resume/escalate exits.
- `baton pipeline`: the dual-worktree preset over the loop engine — writer → reviewer → merger per subtask across two seats, receipt-backed crash-safe merges into trunk.
