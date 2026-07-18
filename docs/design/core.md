# Core engine design — module APIs and test lists

Authoritative plan: `docs/plans/2026-07-11-baton-v1.md` (Gate-1 approved). Where this doc and the plan differ, **the plan wins** — the Concurrency, Receive-transaction, Journal-rotation, Lock-model, and Detector sections were amended across Gate-1 iterations 1–5 and are specified there in full.

## Language and tooling

Plain ESM JavaScript (`.mjs`) with JSDoc types, checked by `tsc --noEmit --checkJs` (dev-only). No build step: hooks invoke source directly. Zero runtime dependencies; strict spec-based flag parsing (`parseFlagsStrict` in commands/shared.mjs — unknown flags, stray positionals, and missing string-flag values are exit-2 usage errors, so a garbled safety flag can never silently lose intent); `node:test` with a small golden-file helper (`UPDATE_GOLDEN=1 npm test` regenerates). Node >= 20.

Testability backbone: every command's `run()` takes an injected `io` object — `{ cwd, env, stdin, stdout, stderr, fs, execFile, now }`. Pure logic (reducers, renderers, resolvers, classifiers) takes plain data and returns plain data. Unit tests run over an in-memory fs fake (`tests/helpers/memfs.mjs`); a thin integration layer uses `fs.mkdtemp` on the real fs.

## File tree

```
core/
├── bin/baton.mjs             # shebang; delegates to src/cli.mjs
├── src/
│   ├── cli.mjs               # routing, --json envelope, exit-code contract
│   ├── commands/             # checkpoint, finalize, detect, remap, receive,
│   │                         #   init, doctor, status, purge-transcript, recover
│   ├── bundle/
│   │   ├── schema.mjs        # emptyBundle, validateBundle, migrate
│   │   ├── store.mjs         # load/write .handoff/, journal, recovery, rotation
│   │   ├── lock.mjs          # operation-scoped lock (see plan §Lock model)
│   │   ├── merge.mjs         # applyEvent reducer (pure)
│   │   ├── normalize.mjs     # hook payload -> baton/event@1 extractors
│   │   ├── compact.mjs       # deterministic size-budget enforcement (pure)
│   │   └── render.mjs        # bundle -> HANDOFF.md (pure)
│   ├── detect/
│   │   ├── signatures.mjs    # load + validate + overlay signature tables
│   │   └── classifier.mjs    # classify(text, exitCode, platform) (pure)
│   ├── roles/
│   │   ├── matrix.mjs        # load/validate baton.config.json
│   │   └── resolve.mjs       # remap resolver (pure, explainable)
│   ├── receive/
│   │   ├── prompt.mjs        # resume-prompt renderer (pure, <=2500 chars)
│   │   └── txn.mjs           # prepare/commit transaction + receipt tokens
│   ├── scaffold/
│   │   ├── plan.mjs          # planInit -> Action[]; applyActions
│   │   ├── gitignore.mjs     # ensure-line (pure text transform)
│   │   ├── managed-block.mjs # <!-- baton:begin/end --> merges
│   │   └── attribution.mjs   # .claude/settings.json deep-merge (pure)
│   ├── git/
│   │   ├── snapshot.mjs      # branch/HEAD/dirty + content digest via execFile
│   │   └── guard.mjs         # scan recent commits for AI trailers
│   └── util/
│       ├── fsx.mjs           # atomicWriteJson, safeReadJson, backupThenWrite
│       ├── jsonl.mjs         # appendEntry, readAllTolerant
│       └── ids.mjs           # bundleId, event dedupeKey (sha256 canonical)
└── data/signatures.v1.json   # versioned limit-signature table (data, not code)
```

Tests mirror this: `tests/{helpers,unit,commands,invariants,integration}/`.

## Bundle schema (`baton/bundle@1`)

`bundle.json` fields: `schema`, `bundleId`, `generation`, `createdAt/updatedAt`, `origin {platform, model, sessionHint, unstable}`, `task {goal, constraints[], acceptance[]}`, `plan.steps[] {id, title, status: pending|active|done|blocked, note}`, `decisions[] {seq, ts, summary, detail(capped)}`, `files {touched[] {path, op, lastTs}, truncated}`, `roles.assignments`, `git {branch, headSha, dirty, dirtySummary[], contentDigest, summaryTruncated} | null`, `handoff {status: open|sealed|received, reason, reasonClass, toPlatformHint, finalizedAt, receive_log[]}`, `journalSeq`, `compaction {droppedDecisions, note}`, `dedupeRing: string[]` (merge idempotency ring, capped 500, oldest evicted), transcript field (opt-in, redacted).

`journal.ndjson` entry: `{seq, ts, type, dedupeKey, writerId, source, payload}`. Types: `decision | plan.set | plan.step | file.touch | note | roles.remap | task.update | git.update`. Every type is self-applicable for replay over `emptyBundle()`.

Size budget (pure `compact.mjs`): decisions capped first-20 + last-150 + marker; `detail` <= 2000 chars; `files.touched` <= 300 (LRU by `lastTs`, sets `files.truncated: true`); `git.dirtySummary` <= 100 lines (sets `git.summaryTruncated: true`; skipped when `git` is null). Deterministic truncation only — no LLM summarization.

## Module APIs

```js
// bundle/schema.mjs
emptyBundle({platform, model, goal}, nowIso) -> Bundle
validateBundle(obj) -> {ok, errors: [{path, msg}]}    // hand-rolled, no deps
migrate(obj) -> Bundle                                 // identity in v1

// bundle/store.mjs  (all take io)
bundlePaths(root) -> {dir, snapshot, bak, journal, handoffMd, historyDir, lockDir, logDir}
loadBundle(root, io) -> {bundle, warnings[]}           // snapshot + replay + recovery
writeSnapshot(root, bundle, io) -> void                // bak -> tmp -> rename, under lock
appendJournal(root, entry, io) -> seq                  // seq allocated under lock
rotateJournal(root, kind, io) -> historyPath           // marker-based, crash-safe (plan §rotation)

// bundle/lock.mjs — operation-scoped; see plan §Lock model for takeover rules
withLock(root, io, fn) -> result                       // acquire -> fn -> release
recoverLock(root, io, {force}) -> {recovered, refusedReason}

// bundle/merge.mjs (pure)
applyEvent(bundle, event) -> Bundle                    // idempotent via dedupeKey ring (500)

// bundle/normalize.mjs
normalizeHookPayload(raw, platform) -> Event[]         // never throws; unknowns -> note

// bundle/render.mjs (pure)
renderHandoffMd(bundle) -> string                      // golden-tested, no AI-credit strings

// detect/
loadSignatures({builtinPath, overlayPath}, io) -> Table // validates, lints regexes
classify({text, exitCode, platform, table, structured}) ->
  {class, signatureId, confidence, resetHint, tried?}   // exit-code rule: plan §detector

// roles/
loadConfig(cwd, io) -> {config, errors[]}
resolveRoles({config, to, avoid, nativeOnly, probes}) ->
  {assignments: {[role]: {platform, model, mode, chainIndex, skipped[]}}, notes[]}

// receive/txn.mjs — see plan §Concurrency for full transition semantics
prepare(root, {platform, origin, reason}, io) -> {token, prompt, assignments, warnings[]}
commit(root, token, io) -> {adopted, generation, archivedTo}   // rejects bound-input drift

// scaffold/
planInit(cwd, opts, io) -> Action[]                    // {path, kind, reason, preview}
applyActions(actions, io) -> Applied[]
mergeAttribution(existingJsonText|null, {force}) -> {text, changed, warnings} | {error}

// git/
snapshot({execFile, cwd}) -> {branch, headSha, dirty, dirtySummary, contentDigest} // 5s timeout
scanCommitsForAiTrailers({execFile, cwd, limit: 50}) -> [{sha, line, pattern}]
```

## Per-module test lists

- **fsx**: atomic write visible-only-after-rename; `.bak` rotation; leftover `.tmp` ignored/cleaned; `safeReadJson` on garbage; Windows rename-retry (EPERM).
- **jsonl/ids**: append+read roundtrip; torn last line dropped with warning; seq monotonic; dedupeKey stable across key order.
- **schema**: empty bundle validates; pathed error per missing field; unknown fields tolerated; `@2` rejected by migrate.
- **merge**: each event type mutates its section; double-apply = identical bundle; unknown type degrades to note; seq ordering.
- **compact**: over-budget collapse deterministic (byte-identical); under-budget identity; truncation markers.
- **store**: snapshot+replay equals pure reduction; corrupt snapshot -> `.bak` recovery; both corrupt -> journal rebuild; torn tail; marker-based rotation roll-forward/back; kill-mid-write sim.
- **lock**: mutual exclusion; provably-dead takeover; live same-host owner refused (incl. `--force`); torn metadata refused; pause-after-final-fence-check; crash between creation and metadata publication.
- **normalize**: `baton/event@1` passthrough; per-harness fixture extraction (Claude Code, Codex, Cursor payloads); malformed-input fuzz never throws.
- **render / receive-prompt**: goldens (minimal, mid-session, finalized, stale, degraded-role); char caps; attribution invariant; determinism.
- **signatures/classifier**: verbatim positive fixtures per platform; negative/near-miss corpus; ANSI stripping; precedence; reset-hint extraction; exit-code interplay matrix; non-limit failing-process fixtures; overlay override; bad-regex rejection; time guard.
- **matrix/resolve**: config validation (pathed errors); chain walking with avoid/disabled/rate-limited skips; native/delegated/forced-default/unavailable; probe-eligibility rules; determinism.
- **txn**: token binds journalSeq + intake + config digest + session + probe snapshot + content-sensitive git digest; one rejection test per bound input; `sealed->received` and `open->received` (degraded seal); ownership adoption + new generation; chained A->B->C; competing receivers; double-commit.
- **scaffold**: gitignore variants (covering pattern no-op, CRLF, trailing newline, idempotent double-run); managed-block replace/append/corrupt-marker-refuse with outside-bytes invariance; attribution merge (absent/present/non-empty/malformed-refuse); `--dry-run` zero writes; real-fs `mkdtemp` + `git init` integration.
- **git**: snapshot on clean/dirty/detached/not-a-repo/timeout; guard trailer fixtures incl. word-boundary false-positive ("Claudette Smith" not flagged).
- **doctor**: check aggregation; `--strict` exit; probe states; version floors; network-FS warning.
- **purge-transcript**: whole-tree secret removal (snapshot, bak, journal, history, log); interruption resume via marker; packaged-bin invocation.
- **invariants**: no AI-credit strings in any rendered output, golden, or template.
- **integration**: e2e failover (init -> 25 checkpoints -> kill-mid-write -> finalize usage-limit -> receive on second platform -> golden prompt); chained A->B->C; six-direction contract matrix; cli-spawn exit codes and `--json` stdout purity.

## CLI contract

Commands: `checkpoint`, `finalize`, `detect`, `remap`, `receive`, `init`, `doctor`, `status`, `purge-transcript`, `recover`, `session-start`. Exit codes: `0` ok · `1` command failure · `2` usage error · `10` usage-limit · `11` throttle · `12` auth · `13` other-error · `14` model-unavailable (a specific model rejected while its platform stays usable — feeds resolver `avoidEntries`). `--json`: exactly one `{ok, data, warnings, error}` envelope on stdout, diagnostics on stderr. Checkpoint soft-fails to exit 0 in hook contexts (`--strict` opts out). `session-start` is the cheap adapter SessionStart gate: soft paths always exit 0 and its BARE stdout is harness-shaped context (not an envelope); with `--json` it honors the envelope contract (`data: {pending, shaped}`). `wrap` is reserved, not implemented in v1.
