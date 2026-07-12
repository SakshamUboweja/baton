<task>
You are the test-verifier for the ADAPTERS wave of the baton project (repo root: current directory). Failing-first tests were just authored for the three harness adapters — the adapter files and the harness scaffold module do not exist yet; failures naming a missing file or ERR_MODULE_NOT_FOUND on the declared target are the expected red state, not findings.

Files under review (complete set, tests/adapters/, 31 runner-visible tests, 30 red + 1 justified positive-control pass):
- claude-code-hooks-json.test.mjs (target FILE adapters/claude-code/hooks/hooks.json)
- claude-code-hook-script.test.mjs (target MODULE adapters/claude-code/scripts/hook.mjs; 9 its once loadable)
- claude-code-manifests.test.mjs (target FILES .claude-plugin/{plugin,marketplace}.json, adapters/claude-code/commands/*.md, skills/handoff-protocol/SKILL.md)
- codex-templates.test.mjs (target FILES adapters/codex/hooks.json, adapters/codex/.agents/skills/baton-handoff/SKILL.md)
- codex-init-writer.test.mjs (target MODULE core/src/scaffold/harness.mjs; 6 its once loadable)
- cursor-templates.test.mjs (target FILES adapters/cursor/{hooks.json,commands/*.md,rules/baton-handoff.mdc})
- cursor-init-writer.test.mjs (target MODULE core/src/scaffold/harness.mjs; 6 its once loadable)

Authoritative contracts (the plan wins over any test pin):
- docs/plans/2026-07-11-baton-v1.md §Claude Code adapter (hook table incl. timeouts 30/30/60/30/10, StopFailure matcher enum, fail-open rule, PostToolUse rejected, SessionStart pending-handoff context, commands incl. receive disable-model-invocation, skill not agent, plugin root = repo root, repo-as-marketplace), §Codex adapter (Stop/PreCompact/SessionStart only, no StopFailure equivalent, .agents/skills per Agent Skills standard, trust gate awareness, commandWindows, merged never clobbered, --with-legacy-prompts demoted), §Cursor adapter (verified events only: stop/afterFileEdit/beforeShellExecution/sessionStart/preCompact; no pre-commit event; ≤5-line .mdc alwaysApply; hooks.json merged not clobbered; --print-prompt universal fallback), §Install/distribution.
- docs/design/platform-notes.md — the verified enum snapshot, event names, plugin.json path-override spike, Codex hooks shape.
- Existing conventions: fakeio/memfs helpers, zero-attribution scanner (mirrored from tests/invariants/attribution.test.mjs), injected-io execFile recording.

Key authored pins to audit (full detail in file headers): single hook entrypoint node "${CLAUDE_PLUGIN_ROOT}/…scripts/hook.mjs" <Event>; runHook(args, io) → exit code, reaching core/bin/baton.mjs via io.execFile with the payload as opts.input; StopFailure → detect + stop-failure-stamped checkpoint; SessionStart emits hookSpecificOutput.additionalContext only for a pending (sealed or usage-limit) foreign bundle; fail-open exit 0; harness writers pinned as NEW module core/src/scaffold/harness.mjs planHarnessInit(cwd,{codex,cursor},io)→Action[] with template-sentinel proof of read-not-embed, per-event array UNION merge, flag gating at module and command layers, whole-memfs no-op double-run.
</task>

<grounding_rules>
Every finding must cite the specific test file + test name and the plan/design clause. No style preferences. Acceptable pinning of open details is not a finding unless it forces a plan violation. The harness.mjs module choice is documented (core.md names no harness writer); treat the location itself as settled. Adapters call the core CLI — tests must not require re-implementing core logic; conversely, a test that would let an adapter BYPASS the core CLI contract (e.g. checkpoint invoked without hook-safety) is a finding.
</grounding_rules>

<verification_loop>
1. Coverage vs the plan's adapter sections: every named surface, event, timeout, gating, and merge rule either tested or explicitly deferred with a reason. Missing plan-invariant coverage is blocking; other gaps major.
2. Correctness of pins: anything contradicting the plan (wrong event set, Claude-shape hooks pinned for Cursor, clobbering merge accepted, fail-open missing, attribution surface unscanned) is blocking.
3. Red-state attribution: each file fails only for its declared cause; the 1 passing test is genuinely a scanner positive-control that cannot green the wave vacuously; 475 pre-existing tests unaffected.
4. Test strength: merge tests must prove user content survives byte-relevant AND both entries coexist; sentinel tests must prove templates are read not embedded; fail-open tests must cover garbage stdin, rejected child, corrupt bundle.
</verification_loop>

<structured_output_contract>
End your reply with exactly this block:

VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS:
1. [blocking|major|minor] — <file> / <test name> — <what is wrong> — <plan/design clause> — Fix: <specific change>
(one numbered line per finding; write "none" if there are no findings)
</structured_output_contract>
