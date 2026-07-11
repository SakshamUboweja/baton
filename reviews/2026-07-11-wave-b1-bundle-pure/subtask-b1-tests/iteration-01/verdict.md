role: test-verifier
model: gpt-5.5 @ xhigh
harness: codex exec -s read-only (codex-cli 0.144.1)
date: 2026-07-11
verdict: BLOCKED
degraded: none
note: findings 1+4 resolved as design-doc amendments (files.truncated documented; dedupeRing + origin.unstable documented) applied by orchestrator before test revision

VERDICT: BLOCKED

FINDINGS:
1. [blocking] — tests/unit/compact.test.mjs/keeps the newest 300 files by lastTs, evicts the oldest, and sets summaryTruncated — requires `files.summaryTruncated`, but core.md puts `summaryTruncated` under `git`, not `files`; a doc-correct implementation would fail — remove this assertion or move truncation metadata to a documented field.

2. [blocking] — tests/unit/compact.test.mjs/missing test: dirtySummary truncation — core.md Size budget requires `dirtySummary <= 100 lines`; current compact tests can pass while leaving `git.dirtySummary` unbounded — add a test that truncates `git.dirtySummary` to 100 lines and sets documented `git.summaryTruncated`.

3. [major] — tests/unit/schema.test.mjs/flags a missing schema field with a pathed error — core.md requires “pathed error per missing field,” but tests only cover a small subset; a validator ignoring `generation`, timestamps, `origin`, `task`, `files`, `roles`, `handoff`, and `compaction` could pass — add table-driven missing-field cases for all required bundle fields and key nested fields.

4. [major] — tests/unit/schema.test.mjs/returns a baton/bundle@1 with the exact documented default shape — pins undocumented defaults/fields (`dedupeRing`, `origin.unstable: false`, exact `compaction` shape); HYPOTHESIS: docs imply a dedupe ring exists, but Bundle schema does not name `dedupeRing` — either document these fields or relax the exact-shape assertion to required contract fields.

5. [minor] — tests/unit/merge.test.mjs/unknown type: degrades to a decision-log entry, never throws, still bumps the clock — assertion that summary is merely a string is weak; empty/unhelpful degradation would pass and not prove “degrades to note” usefully — assert non-empty summary including the unknown event type or source.
