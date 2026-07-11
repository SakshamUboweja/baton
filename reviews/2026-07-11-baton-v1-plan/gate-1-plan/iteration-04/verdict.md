role: plan-reviewer
model: gpt-5.6-sol @ xhigh
harness: codex exec -s read-only (codex-cli 0.144.1)
date: 2026-07-11
verdict: BLOCKED
degraded: none

VERDICT: BLOCKED

FINDINGS:

1. [blocking] — Core engine / Concurrency — “a still-alive-but-stale owner requires explicit `baton recover --force`” contradicts “correctness rests on the provably-dead takeover rule.” A live writer paused after its final fencing check can resume after forced recovery and corrupt the new generation. Lock lifetime is also unclear: hook processes are short-lived, while “heartbeat refreshes on every checkpoint” implies a session lease. — Make mutation locks explicitly operation-scoped and keep logical session ownership in `bundle.json`; refuse recovery when a same-host owner is confirmed alive, requiring the user to terminate it first. Treat unverifiable/cross-host ownership as unsupported rather than safe. Add tests for force attempted against a live paused writer and crash between lock creation and owner-metadata publication. Replace Acceptance Constraint 6’s ambiguous “stale-lock takeover” with “provably-dead takeover; live/unknown-owner refusal.”

2. [major] — Claude Code adapter / StopFailure — “matchers: `rate_limit`, `overloaded`, …” does not match the current documented enum, which includes `authentication_failed`, `oauth_org_not_allowed`, `invalid_request`, and `max_output_tokens`; `overloaded` is not listed. This conflicts with “tests cover every documented error type.” [Claude’s current hook reference](https://code.claude.com/docs/en/hooks) otherwise confirms StopFailure adoption and ignored output/exit behavior. — Replace the illustrative list with the exact verified enum, generate matcher fixtures from that canonical list, and make unknown future values normalize safely.

3. [major] — Core engine / Receive transaction — “the token binds … `journalSeq` … probe snapshot” is followed by “`--commit` rejects … a HEAD move,” but HEAD or the live dirty-worktree fingerprint is not among the bound inputs. A checkout or uncommitted edit can therefore invalidate the prepared audit/prompt without changing `journalSeq`. — Bind the complete prepare-time git snapshot digest—HEAD, branch, and normalized dirty summary—or explicitly rerun and compare it at commit. Add HEAD-change, dirty-change, config-change, and probe-change rejection tests, not only prepare-vs-checkpoint races.

4. [minor] — Transcript policy / Claude hooks — “errors log to `.handoff/log/`” is outside the enumerated purge targets, despite the whole-tree secret-removal guarantee. HYPOTHESIS: if parse failures or diagnostics include raw hook input, transcript secrets could survive purge. — Specify metadata-only/redacted logging, bounded retention, and either purge logs or prove through fixtures that raw payloads never enter them.

MISSING:

- An explicit operation-lock lifecycle and conservative behavior for missing, torn, or unverifiable owner metadata across Linux, macOS, and Windows.
- Receipt-token tests for every declared drift input.
- A redaction and retention contract for `.handoff/log/`.
- No other missing requirements found: the named iteration 1–3 findings are otherwise adequately dispositioned, including Codex/Cursor hooks, build ordering, root/sandbox degradation, detector hardening, compatibility, threat model, packaging, probing, and six-direction chaining.
