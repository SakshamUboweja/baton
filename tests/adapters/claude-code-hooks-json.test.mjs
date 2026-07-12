import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// ADAPTERS wave — RED. Static-surface contract for the Claude Code plugin hook
// manifest.
//
// TARGET FILE (sole red cause): <repoRoot>/adapters/claude-code/hooks/hooks.json.
// It does NOT exist yet, so every test here fails on the missing FILE with an
// unambiguous message (asserted first in each block). This is a static JSON/shape
// pin, not a module-load pin — there is no `import` of a not-yet-authored module,
// so the failure is a clear "file missing", never ERR_MODULE_NOT_FOUND.
//
// Source of truth: plan §Claude Code adapter (the hook table) + docs/design/
// platform-notes.md §Claude Code (verified hook events + the StopFailure matcher
// ENUM snapshot). This file re-implements NO core logic — it only pins the shape
// of the shipped manifest.
//
// PINS (open details resolved here; the implementer follows these bytes):
//   H1. Plugin hooks.json shape is the proven Claude Code plugin format
//       (mirrors the installed openai-codex plugin's hooks/hooks.json):
//         { "hooks": { "<Event>": [ { "matcher"?: string,
//             "hooks": [ { "type": "command", "command": string,
//                          "timeout": number } ] } ] } }
//   H2. Exactly these five events are configured — no more, no fewer:
//       StopFailure, Stop, PreCompact, SessionEnd, SessionStart.
//       (PostToolUse is explicitly REJECTED by the plan; PostCompact is not used.)
//   H3. The StopFailure matcher surface covers the FULL verified enum snapshot
//       from platform-notes verbatim (union of all matcher strings under
//       StopFailure contains every token). Layout-agnostic: one alternation
//       matcher or one group per type both satisfy this.
//   H4. Single-entrypoint dispatch: EVERY command is
//         node "${CLAUDE_PLUGIN_ROOT}/…/scripts/hook.mjs" <Event>
//       i.e. it invokes `node`, references ${CLAUDE_PLUGIN_ROOT}, points at the
//       single entrypoint scripts/hook.mjs, and passes its own event name as an
//       argument. "reaching core/bin/baton.mjs" (task wording) is realised by
//       hook.mjs itself — pinned in claude-code-hook-script.test.mjs, which
//       asserts hook.mjs spawns core/bin/baton.mjs. hooks.json's contract is only
//       that it routes through the entrypoint under the plugin root.
//   H5. Per-event timeouts match the plan's hook table exactly:
//       StopFailure 30, Stop 30, PreCompact 60, SessionEnd 30, SessionStart 10.
//   H6. Every leaf hook is {type:"command"}.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const HOOKS_JSON = join(repoRoot, 'adapters', 'claude-code', 'hooks', 'hooks.json');

const MISSING = `${HOOKS_JSON} must exist — the ADAPTERS wave implementer authors the Claude Code plugin hook manifest here`;

// Verbatim from docs/design/platform-notes.md §Claude Code (StopFailure enum
// snapshot, code.claude.com/docs/en/hooks, 2026-07-11).
const STOP_FAILURE_ENUM = [
  'rate_limit',
  'overloaded',
  'authentication_failed',
  'oauth_org_not_allowed',
  'billing_error',
  'invalid_request',
  'model_not_found',
  'server_error',
  'max_output_tokens',
  'unknown',
];

const EXPECTED_EVENTS = ['StopFailure', 'Stop', 'PreCompact', 'SessionEnd', 'SessionStart'];
const EXPECTED_TIMEOUT = { StopFailure: 30, Stop: 30, PreCompact: 60, SessionEnd: 30, SessionStart: 10 };

/** Load + parse the manifest, or fail with the unambiguous missing-file message. */
function loadHooks() {
  assert.ok(existsSync(HOOKS_JSON), MISSING);
  const raw = readFileSync(HOOKS_JSON, 'utf8');
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    assert.fail(`${HOOKS_JSON} is not valid JSON: ${/** @type {any} */ (err).message}`);
  }
  assert.ok(json && typeof json.hooks === 'object' && json.hooks !== null, 'the manifest carries a top-level "hooks" object');
  return json.hooks;
}

/** All leaf command hook items configured under one event. */
function commandItems(hooks, event) {
  const groups = hooks[event];
  assert.ok(Array.isArray(groups) && groups.length > 0, `event ${event} maps to a non-empty array of hook groups`);
  const items = [];
  for (const g of groups) {
    assert.ok(g && Array.isArray(g.hooks), `each ${event} group carries a hooks[] array`);
    items.push(...g.hooks);
  }
  return items;
}

// ===========================================================================
describe('claude-code hooks.json — event coverage (H2)', () => {
  it('configures EXACTLY StopFailure, Stop, PreCompact, SessionEnd, SessionStart', () => {
    const hooks = loadHooks();
    assert.deepEqual([...Object.keys(hooks)].sort(), [...EXPECTED_EVENTS].sort(), 'exactly the five planned events are configured (PostToolUse rejected)');
  });
});

// ===========================================================================
describe('claude-code hooks.json — StopFailure matcher enum snapshot (H3)', () => {
  it('the StopFailure matchers cover every verified enum error type verbatim', () => {
    const hooks = loadHooks();
    const groups = hooks.StopFailure;
    assert.ok(Array.isArray(groups) && groups.length > 0, 'StopFailure maps to hook groups');
    const matcherText = JSON.stringify(groups.map((g) => g.matcher ?? ''));
    for (const type of STOP_FAILURE_ENUM) {
      assert.ok(matcherText.includes(type), `StopFailure must filter the "${type}" error type (full enum snapshot from platform-notes)`);
    }
  });
});

// ===========================================================================
describe('claude-code hooks.json — single-entrypoint command wiring (H4, H6)', () => {
  it('every command invokes node on ${CLAUDE_PLUGIN_ROOT}/…/scripts/hook.mjs', () => {
    const hooks = loadHooks();
    for (const event of EXPECTED_EVENTS) {
      for (const item of commandItems(hooks, event)) {
        assert.equal(item.type, 'command', `${event} hooks are command hooks (H6)`);
        const cmd = String(item.command);
        assert.match(cmd, /^node\s/, `${event} command runs node`);
        assert.ok(cmd.includes('${CLAUDE_PLUGIN_ROOT}'), `${event} command resolves under \${CLAUDE_PLUGIN_ROOT}`);
        assert.ok(cmd.includes('scripts/hook.mjs'), `${event} command routes through the single entrypoint scripts/hook.mjs`);
      }
    }
  });

  it('each event passes its own name as an argument to the entrypoint', () => {
    const hooks = loadHooks();
    for (const event of EXPECTED_EVENTS) {
      const cmds = commandItems(hooks, event).map((h) => String(h.command));
      assert.ok(
        cmds.some((c) => new RegExp(`\\b${event}\\b`).test(c)),
        `at least one ${event} command passes "${event}" so the single entrypoint can dispatch it`,
      );
    }
  });
});

// ===========================================================================
describe('claude-code hooks.json — per-event timeouts match the plan table (H5)', () => {
  it('StopFailure/Stop/SessionEnd=30, PreCompact=60, SessionStart=10', () => {
    const hooks = loadHooks();
    for (const event of EXPECTED_EVENTS) {
      for (const item of commandItems(hooks, event)) {
        assert.equal(item.timeout, EXPECTED_TIMEOUT[event], `${event} command timeout must be ${EXPECTED_TIMEOUT[event]}s (plan hook table)`);
      }
    }
  });
});
