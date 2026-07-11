# Platform facts and Task-0 spike results

Verified 2026-07-11 against official docs and this machine. Re-verify floors when bumping compatibility policy.

## Task-0 spikes

- **plugin.json path overrides: CONFIRMED.** The manifest supports custom component paths — `"skills": "./custom/skills/"`, `"commands": ["./custom/commands/x.md"]`, `"agents": [...]`, `"hooks": "./config/hooks.json"` (code.claude.com/docs/en/plugins-reference). Repo-root-as-plugin with paths into `adapters/claude-code/` is viable; no vendoring fallback needed.
- **npm name**: `baton` is taken (placeholder 0.0.0). Publishing as **`@sakshamuboweja/baton`** (confirmed 404/available) with `bin: baton`.
- **Manifest is optional** — if omitted, components auto-discover from default locations; we use an explicit manifest for the path overrides.

## Claude Code

- Hook events include `Stop`, `StopFailure`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `PostToolUseFailure`, and others.
- **`StopFailure`** fires when a turn ends due to an API error; output and exit code are ignored (observability-only). Matcher filters by error type. **Enum snapshot (2026-07-11, code.claude.com/docs/en/hooks):** `rate_limit`, `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `unknown`. Note: a Gate-1 reviewer disputed `overloaded`'s presence in the current enum — fixtures are generated from this snapshot and unknown values normalize to `unknown`, so drift is safe either way. Re-snapshot before freezing fixtures.
- Limit strings (fallback tier): `You've hit your session limit · resets …` / `weekly limit` / `Opus limit`; throttle: `Server is temporarily limiting requests (not your usage limit)`; `API Error: Request rejected (429)`.
- **Live capture (2026-07-12, this machine)**: a subagent died with `Agent terminated early due to an API error: You've hit your session limit · resets 2am (Asia/Dubai)` — reset hints can carry a timezone suffix in parentheses; the resetHint extractor and fixtures must cover this variant.
- Attribution: `"attribution": {"commit": "", "pr": ""}` in settings.json (`includeCoAuthoredBy` is deprecated).

## Codex CLI (>= 0.144; this machine: 0.144.1)

- Lifecycle hooks: `SessionStart`, `SubagentStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`. Config: `~/.codex/hooks.json`, `<repo>/.codex/hooks.json`, or config.toml `[hooks]` tables. Payload: stdin JSON with `session_id`, `cwd`, `hook_event_name`, `model`, `transcript_path` (+ `turn_id` for turn-scoped).
- **Trust gate**: non-managed command hooks require review of the exact definition; trust recorded against the hook's hash; new/changed hooks skipped until re-trusted via `/hooks`. Project hooks load only when the project `.codex/` layer is trusted.
- `commandWindows` / `command_windows` = Windows-only command override.
- Custom prompts (`~/.codex/prompts/*.md`) are deprecated upstream — legacy fallback only.
- Skills: Agent Skills standard at `.agents/skills` (repo) and `~/.agents/skills` (user).
- Limit string: `You've hit your usage limit. … try again at [date/time]`; `codex exec --json` exits non-zero on failure (nonzero alone never classifies as usage-limit).
- gpt-5.6-sol is server-gated by CLI version (rejected on 0.135.0 with "requires a newer version of Codex"; works on 0.144.1).

## Cursor

- Hook events (verified; cursor.com/docs/agent/hooks): `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeTabFileRead`, `afterTabFileEdit`, `beforeSubmitPrompt`, `preCompact`, `afterAgentResponse`, `afterAgentThought`, `stop`, `workspaceOpen`.
- **There is no pre-commit/VCS hook.** Agent-issued commits are observable via `beforeShellExecution` with a git-commit matcher; SCM-UI commits are invisible.
- Config: `.cursor/hooks.json` (project; requires trusted workspace), `~/.cursor/hooks.json` (user), enterprise/MDM paths. Format: `{"version": 1, "hooks": {"<event>": [{"command", "timeout", "matcher"}]}}`.
- No `commandWindows` variant — cross-platform command strings.
- BYO-key rate-limit JSON: `{"error": "Too Many Requests", "message": "Rate limit exceeded…"}`; managed-billing error schema undocumented (heuristics, `confidence: low`).
- cursor-agent reads `AGENTS.md` and `CLAUDE.md` natively; `.cursor/commands` CLI loading unconfirmed — `baton receive --print-prompt` is the universal fallback.
