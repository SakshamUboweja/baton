role: test-verifier
model: gpt-5.5 @ xhigh
harness: codex exec -s read-only (codex-cli 0.144.1)
date: 2026-07-12
verdict: BLOCKED
degraded: none

VERDICT: BLOCKED
FINDINGS:
1. [blocking] — tests/unit/resolve.test.mjs / `nativeOnly falls back to forced-default when the only native entry is ineligible (rate-limited)` — contradicts the plan: rate-limited platforms are skipped like `avoid[]`. This test requires selecting `defaults.codex` while `codex` is rate-limited. Fix: forced-default only if `to` is probe-eligible; otherwise expect `unavailable` with a `rate-limited` skip/audit entry.
2. [blocking] — tests/unit/signatures.test.mjs / `shipped built-in table` + tests/unit/classifier.test.mjs / `negative / near-miss corpus` — weak split: negatives use inline `BASE`, while the real shipped table is only positive-pinned. An overbroad built-in regex could false-positive “usage limit” prose and still pass. Fix: classify the real `core/data/signatures.v1.json` against the required negative/near-miss corpus.
3. [major] — tests/unit/signatures.test.mjs / `validation` + `overlay merge` — required regex hardening is incomplete: no invalid-regex syntax case, no linear-time/pathological construct rejection, no classifier match time-guard test. Fix: add those cases for both built-in and overlay paths.
4. [major] — tests/unit/classifier.test.mjs / `structured-first (StopFailure errorType map)` — structured coverage is incomplete. Platform notes list `invalid_request`, `model_not_found`, and `max_output_tokens`, but tests omit them; the plan also requires Codex structured limit evidence, but only Claude StopFailure is covered. Fix: add all enum cases and a Codex structured fixture that wins over text/exit code.
5. [major] — tests/integration/detect-cli.test.mjs / `baton detect (integration, spawn)` — CLI exit mapping is incomplete: `auth -> 12` and `--signatures <path>` overlay are contractually required but untested. Fix: add an auth fixture and a spawn-level overlay hot-patch test.
6. [major] — tests/unit/resolve.test.mjs / `skip reasons` — core test list requires `avoid/disabled/rate-limited` skips, but `disabled` is missing. Fix: define the disabled config shape and assert disabled entries are skipped with audited `skipped[]`.
