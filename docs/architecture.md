# Architecture

baton is a zero-dependency Node CLI (`core/`) plus thin per-harness adapters
(`adapters/`). It never wraps or proxies a harness; it rides alongside one,
checkpointing work so another harness can pick it up when the first dies on a
usage limit.

## The bundle

All state lives in a gitignored `.handoff/` directory at the repo root:

- `bundle.json` — the active snapshot (origin platform/model, task goal and
  acceptance, plan steps, files touched, git branch/HEAD/dirty summary, role
  assignments, and the handoff seal). Written atomically (tmp + rename) with a
  `.bak` of the previous good copy.
- `journal.ndjson` — append-only events; the snapshot is a periodic fold of the
  journal, so a torn tail is tolerated and recoverable.
- `HANDOFF.md` — the rendered, human-readable seal.
- `history/` — rotated snapshots and journals with bounded retention.

Size is controlled by deterministic truncation only — never LLM summarization.

## How work is captured

- **Mechanical checkpoint** (`baton checkpoint`) — hook-driven, no LLM cost.
  Records git state, files touched, and timestamps. Safe to run every turn.
- **Narrative seal** (`baton finalize`, surfaced as `/handoff`) — a
  model-written record of decisions, verified-vs-claimed status, next steps, and
  the reason for switching.

Adapters send a normalized `baton/event@1` on stdin; raw hook payloads get
best-effort extraction that never throws. All checkpoint paths fail open (exit 0
on soft failure) so a checkpoint can never break the host harness.

## Limit detection

Two tiers, structured first: Claude Code exposes a `StopFailure` event with an
error-type matcher (the primary, structured signal); Codex and Cursor fall back
to versioned text signatures (`core/data/`). A generic non-zero exit never
classifies as a usage limit on its own — that requires limit-specific evidence.
Signatures are data, overlay-able for drift, and matched after ANSI stripping.

## Roles and remap

`baton.config.json` maps abstract roles (planner, reviewer, implementer, …) to
ordered platform+model chains. The resolver is pure and explainable: it skips
the platform that just died, honors availability probes, and records why each
choice was made. Offline resolution always succeeds, flagged degraded.

## Receive: a two-phase transaction

`receive --prepare` validates, resolves roles, and returns a resume prompt plus a
one-time token that binds the bundle revision, intake, config digest, target
session, and a content-sensitive git digest. `receive --commit <token>`
re-derives every bound input, rejects any drift, and performs one atomic
transition — adopting the receiving session as the bundle's owner and opening a
fresh writable generation, so chained A→B→C failover works. Bundle content is
framed to the receiving model as claims to audit against the working tree, not
instructions to obey.

## Concurrency

Every mutation runs under an operation-scoped repo lock (`.handoff/lock`,
acquired atomically). Logical ownership lives in the bundle, not the lock.
Automatic recovery happens only when the prior owner is provably dead; a live or
unverifiable owner is refused rather than stolen from.

## Presets over the same engine

- **`baton loop`** — a goal supervisor that runs a repo-local `loop.json` plan
  through headless writer/reviewer roles, with a smoke-test approval gate and
  explicit park / resume / escalate. Review gates loop at most five iterations.
- **`baton pipeline`** — a dual-worktree write → review → merge cycle across two
  isolated git worktrees, merging into the trunk only after two independent
  read-only checks pass. Merges are crash-safe via receipts.

## Boundaries (v1)

Local filesystems only (lock/rename atomicity is not guaranteed on network
mounts; `doctor` warns). Discovery stops at a nested independent git repository.
Non-git directories are supported with git-dependent features degraded.
