import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { cmdInit } from '../../core/src/commands/init.mjs';
// SOLE RED CAUSE for this file: the harness writer module below does not exist
// yet, so this static import throws ERR_MODULE_NOT_FOUND at load and every test
// reds with that single cause. (makeIo + cmdInit resolve fine — only harness.mjs
// is missing.)
import { planHarnessInit } from '../../core/src/scaffold/harness.mjs';

// ---------------------------------------------------------------------------
// ADAPTERS wave — RED. `baton init --codex` writer contract.
//
// TARGET MODULE (the pinned NEW home for harness-writer logic):
//   core/src/scaffold/harness.mjs.
// docs/design/core.md's scaffold/ layout names plan.mjs, gitignore.mjs,
// managed-block.mjs, attribution.mjs — it does NOT name a harness writer, so per
// the wave brief the NEW writer logic is pinned on core/src/scaffold/harness.mjs
// (documented choice). This keeps the RED cause clean: `baton init --codex`
// EXTENDS the existing core/src/commands/init.mjs, but the merge/gating logic
// lives in this NEW module, so the failure is ERR_MODULE_NOT_FOUND on harness.mjs
// rather than a wrong-behaviour failure inside an existing module.
//
// Source of truth: plan §Codex adapter ("repo .codex/hooks.json (written by
// init --codex, merged never clobbered)"; ".agents/skills/baton-handoff/SKILL.md
// per the Agent Skills standard"; "~/.codex/prompts/*.md demoted to legacy
// fallback only, written only with --with-legacy-prompts. The notify shim is
// cut; ~/.codex/config.toml is never touched") + build order phase 3.
//
// PINNED CONTRACT:
//   W0. `planHarnessInit(cwd, opts, io) -> Action[]` — read-only planner (same
//       Action shape as scaffold/plan.mjs: {id, path, op:'write'|'skip'|'refuse',
//       preview?, note?}). opts = {codex?: boolean, cursor?: boolean,
//       withLegacyPrompts?: boolean}. It reads the packaged adapter templates
//       (adapters/codex/hooks.json and
//       adapters/codex/.agents/skills/baton-handoff/SKILL.md), resolved relative
//       to harness.mjs via import.meta.url exactly as plan.mjs resolves
//       templates/, through the injected io.fs.
//   W1. --codex plans a WRITE of <cwd>/.codex/hooks.json whose preview is valid
//       JSON carrying baton's Stop/PreCompact/SessionStart hooks (and surfaces the
//       packaged template's bytes — it must READ the template, not embed).
//   W2. MERGE NEVER CLOBBER (verifier fold V6 — deep, ALL events): pre-existing
//       user entries survive as EXACT OBJECTS (assert.deepStrictEqual against a
//       merged array member, not string inclusion) for EVERY baton event — Stop,
//       PreCompact, SessionStart — with the baton entry coexisting in the SAME
//       array; a foreign user event (PostToolUse) also survives exactly.
//   W3. GATED: planHarnessInit(cwd, {}, io) plans NOTHING under .codex/ or
//       .agents/.
//   W4. Command wiring (through cmdInit, the observable surface):
//       - plain `baton init` NEVER creates .codex/ or .agents/.
//       - `baton init --codex` creates a valid <root>/.codex/hooks.json.
//       - a second `baton init --codex` is a NO-OP (whole memfs byte-identical).
//   W5. SKILL INSTALL (verifier fold V4): --codex also plans/writes
//       <cwd>/.agents/skills/baton-handoff/SKILL.md whose content surfaces the
//       packaged skill template's bytes (read-not-embed sentinel), pinned at the
//       module layer AND through cmdInit.
//   W6. LEGACY PROMPTS + NEVER-TOUCHED SURFACES (verifier fold V5):
//       - by default (--codex, no legacy flag) NO action touches
//         <HOME>/.codex/prompts, any config.toml, or any notify shim path;
//       - opts.withLegacyPrompts (CLI: --with-legacy-prompts) plans >=1 legacy
//         prompt write under `${io.env.HOME}/.codex/prompts/*.md` mentioning
//         baton (prompt BODY content is deliberately unpinned — it is a
//         deprecated fallback and may be embedded; no packaged template pinned);
//       - command layer pins the NEGATIVES (plain init and --codex leave the
//         fake HOME's .codex untouched and create no config.toml/notify file
//         anywhere). The command-layer POSITIVE for --with-legacy-prompts is
//         deliberately left at the module layer per the verifier's allowance:
//         pinning HOME plumbing through cmdInit would pin bin-level env wiring
//         this wave does not own.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const TPL_DIR = join(repoRoot, 'templates');
const CODEX_TPL = join(repoRoot, 'adapters', 'codex', 'hooks.json'); // module-resolved packaged template
const CODEX_SKILL_TPL_PATH = join(repoRoot, 'adapters', 'codex', '.agents', 'skills', 'baton-handoff', 'SKILL.md');
const ROOT = '/repo';
const HOME = '/home/u';

// Per-event read-not-embed sentinels: content only reachable by READING the
// packaged template files seeded below.
const MARK = {
  Stop: 'BATON_CODEX_STOP_MARK',
  PreCompact: 'BATON_CODEX_PRECOMPACT_MARK',
  SessionStart: 'BATON_CODEX_SESSIONSTART_MARK',
};
const SKILL_MARK = 'BATON_CODEX_SKILL_MARK';

const CODEX_HOOKS_TPL = JSON.stringify({
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: `baton checkpoint --platform codex ${MARK.Stop}`, commandWindows: 'baton checkpoint --platform codex' }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: `baton checkpoint --platform codex ${MARK.PreCompact}`, commandWindows: 'baton checkpoint --platform codex' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: `baton receive --print-prompt --platform codex ${MARK.SessionStart}`, commandWindows: 'baton receive --print-prompt --platform codex' }] }],
  },
}, null, 2);
const CODEX_SKILL_TPL = `---\nname: baton-handoff\ndescription: Cross-harness handoff protocol (${SKILL_MARK})\n---\n\nCheckpoint, seal, receive.\n`;

// Minimal base templates so cmdInit's planInit half succeeds (mirrors init.test).
const CONFIG_TPL = JSON.stringify({ schema: 'baton/config@1', roles: {}, platforms: {}, defaults: {} }, null, 2);
const AGENTS_TPL = '## Handoff protocol\n\nCheckpoint after each subtask.\n';
const CLAUDE_TPL = '@AGENTS.md\n\n- Prefer /baton:* commands.\n';
const PKG = JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } });
const GIT_CLEAN = {
  'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
  'git rev-parse HEAD': { stdout: 'abc123\n' },
  'git status --porcelain': { stdout: '' },
  'git diff --cached': { stdout: '' },
  'git diff': { stdout: '' },
  'git ls-files --others --exclude-standard': { stdout: '' },
};

/** io seeded with the packaged codex templates only (for direct planHarnessInit). */
function moduleIo(extra = {}) {
  return makeIo({
    files: { [CODEX_TPL]: CODEX_HOOKS_TPL, [CODEX_SKILL_TPL_PATH]: CODEX_SKILL_TPL, ...extra },
    env: { HOME },
  });
}
/** io seeded for a full cmdInit run (base templates + codex templates + git). */
function cmdIo(extra = {}) {
  return makeIo({
    files: {
      [join(TPL_DIR, 'baton.config.json.tpl')]: CONFIG_TPL,
      [join(TPL_DIR, 'AGENTS.md.tpl')]: AGENTS_TPL,
      [join(TPL_DIR, 'CLAUDE.md.tpl')]: CLAUDE_TPL,
      [CODEX_TPL]: CODEX_HOOKS_TPL,
      [CODEX_SKILL_TPL_PATH]: CODEX_SKILL_TPL,
      [`${ROOT}/package.json`]: PKG,
      ...extra,
    },
    execResults: GIT_CLEAN,
    env: { HOME },
  });
}
const codexHooksAction = (actions) => actions.find((a) => /\/\.codex\/hooks\.json$/.test(a.path));
const skillAction = (actions) => actions.find((a) => /\/\.agents\/skills\/baton-handoff\/SKILL\.md$/.test(a.path));
const harnessSurface = (actions) => actions.filter((a) => /\/\.codex\/|\/\.agents\//.test(a.path));

/** Exact-object membership: deepStrictEqual against some array member (V6). */
const deepIncludes = (arr, obj) =>
  Array.isArray(arr) &&
  arr.some((x) => {
    try {
      assert.deepStrictEqual(x, obj);
      return true;
    } catch {
      return false;
    }
  });

// ===========================================================================
describe('planHarnessInit(--codex) — writes .codex/hooks.json from the packaged template (W1)', () => {
  it('plans a valid-JSON write carrying baton Stop/PreCompact/SessionStart hooks + the template bytes', () => {
    const io = moduleIo();
    const actions = planHarnessInit(ROOT, { codex: true }, io);
    const a = codexHooksAction(actions);
    assert.ok(a, 'a .codex/hooks.json action is planned');
    assert.equal(a.op, 'write', 'a fresh tree writes the file');
    assert.equal(a.path, `${ROOT}/.codex/hooks.json`, 'the target is <root>/.codex/hooks.json');

    const merged = JSON.parse(a.preview);
    for (const ev of ['Stop', 'PreCompact', 'SessionStart']) {
      assert.ok(Array.isArray(merged.hooks[ev]) && merged.hooks[ev].length > 0, `the written hooks carry ${ev}`);
      assert.ok(JSON.stringify(merged.hooks[ev]).includes(MARK[ev]), `the packaged ${ev} template bytes surface (init reads the template, does not embed)`);
    }
  });
});

// ===========================================================================
describe('planHarnessInit(--codex) — skill install (W5)', () => {
  it('plans a write of .agents/skills/baton-handoff/SKILL.md surfacing the packaged skill template', () => {
    const io = moduleIo();
    const a = skillAction(planHarnessInit(ROOT, { codex: true }, io));
    assert.ok(a, 'a .agents/skills/baton-handoff/SKILL.md action is planned');
    assert.equal(a.op, 'write');
    assert.equal(a.path, `${ROOT}/.agents/skills/baton-handoff/SKILL.md`, 'the skill installs into the target repo per the Agent Skills standard');
    assert.ok(String(a.preview).includes(SKILL_MARK), 'the packaged skill template bytes surface (read-not-embed)');
    assert.match(String(a.preview), /(^|\n)name:\s*baton-handoff\b/, 'the installed skill declares name: baton-handoff');
  });
});

// ===========================================================================
describe('planHarnessInit(--codex) — merge never clobbers user hooks (W2, V6 deep + all events)', () => {
  it('EXACT pre-existing user entries survive for EVERY baton event, with the baton entry coexisting in the same array', () => {
    const USER = {
      Stop: { hooks: [{ type: 'command', command: 'USER_STOP_HOOK' }] },
      PreCompact: { matcher: 'user-precompact', hooks: [{ type: 'command', command: 'USER_PRECOMPACT_HOOK' }] },
      SessionStart: { hooks: [{ type: 'command', command: 'USER_SESSIONSTART_HOOK', timeout: 7 }] },
      PostToolUse: { matcher: 'Write', hooks: [{ type: 'command', command: 'USER_HOOK_KEEP_ME' }] },
    };
    const existing = JSON.stringify({
      hooks: {
        PostToolUse: [USER.PostToolUse],
        Stop: [USER.Stop],
        PreCompact: [USER.PreCompact],
        SessionStart: [USER.SessionStart],
      },
    });
    const io = moduleIo({ [`${ROOT}/.codex/hooks.json`]: existing });

    const a = codexHooksAction(planHarnessInit(ROOT, { codex: true }, io));
    assert.ok(a && a.op === 'write', 'merging an existing file plans a write');
    const merged = JSON.parse(a.preview);

    // Foreign user event survives as the exact object.
    assert.ok(deepIncludes(merged.hooks.PostToolUse, USER.PostToolUse), 'the foreign PostToolUse user hook survives deep-equal (never clobbered)');

    // For EVERY baton event: exact user entry survives AND baton's entry coexists.
    for (const ev of ['Stop', 'PreCompact', 'SessionStart']) {
      assert.ok(deepIncludes(merged.hooks[ev], USER[ev]), `(V6) the user's ${ev} entry survives as the EXACT object (deepStrictEqual member)`);
      assert.ok(JSON.stringify(merged.hooks[ev]).includes(MARK[ev]), `(V6) baton's ${ev} entry coexists in the same array`);
    }
  });
});

// ===========================================================================
describe('planHarnessInit — gated behind the flag (W3)', () => {
  it('with no harness flags, nothing under .codex/ or .agents/ is planned', () => {
    const io = moduleIo();
    const actions = planHarnessInit(ROOT, {}, io);
    assert.deepEqual(harnessSurface(actions).map((a) => a.path), [], 'plain init plans no .codex/ or .agents/ surface');
  });
});

// ===========================================================================
describe('planHarnessInit(--codex) — legacy prompts gating + never-touched surfaces (W6)', () => {
  const FORBIDDEN = /\.codex\/prompts|config\.toml|notify/i;

  it('by default plans NOTHING under ~/.codex/prompts, no config.toml, no notify shim', () => {
    const io = moduleIo();
    const actions = planHarnessInit(ROOT, { codex: true }, io);
    assert.deepEqual(
      actions.filter((a) => FORBIDDEN.test(a.path)).map((a) => a.path),
      [],
      'legacy prompts are opt-in only; config.toml and the notify shim are NEVER touched (the shim is cut)',
    );
  });

  it('withLegacyPrompts plans a legacy prompt write under ${HOME}/.codex/prompts/*.md', () => {
    const io = moduleIo();
    const actions = planHarnessInit(ROOT, { codex: true, withLegacyPrompts: true }, io);
    const legacy = actions.filter((a) => a.path.startsWith(`${HOME}/.codex/prompts/`) && a.path.endsWith('.md'));
    assert.ok(legacy.length >= 1, 'the legacy flag plans at least one ~/.codex/prompts/*.md write');
    assert.ok(legacy.every((a) => a.op === 'write' && typeof a.preview === 'string' && a.preview.includes('baton')), 'each legacy prompt is a write whose body mentions baton');
    // Even with the legacy flag, config.toml and the notify shim stay untouched.
    assert.deepEqual(actions.filter((a) => /config\.toml|notify/i.test(a.path)), [], 'config.toml / notify shim are never planned, flag or no flag');
  });
});

// ===========================================================================
describe('baton init --codex — command gating + no-op double run (W4, W5, W6 negatives)', () => {
  const homeCodexKeys = (io) => Object.keys(io.files()).filter((k) => k.startsWith(`${HOME}/.codex`));
  const forbiddenKeys = (io) => Object.keys(io.files()).filter((k) => /config\.toml|notify/i.test(k));

  it('plain `baton init` NEVER creates .codex/, .agents/, ~/.codex, config.toml, or a notify shim', async () => {
    const io = cmdIo();
    const code = await cmdInit([], io);
    assert.equal(code, 0, `init should succeed; stderr: ${io.stderrText()}`);
    assert.equal(io.files()[`${ROOT}/.codex/hooks.json`], undefined, 'plain init leaves .codex/ uncreated (gated behind --codex)');
    assert.equal(io.files()[`${ROOT}/.agents/skills/baton-handoff/SKILL.md`], undefined, 'plain init installs no skill');
    assert.deepEqual(homeCodexKeys(io), [], 'plain init writes nothing under the user HOME .codex');
    assert.deepEqual(forbiddenKeys(io), [], 'plain init creates no config.toml / notify file anywhere');
  });

  it('`baton init --codex` creates a valid .codex/hooks.json AND the baton-handoff skill; still no HOME/config.toml/notify writes', async () => {
    const io = cmdIo();
    const code = await cmdInit(['--codex'], io);
    assert.equal(code, 0, `init --codex should succeed; stderr: ${io.stderrText()}`);

    const text = io.files()[`${ROOT}/.codex/hooks.json`];
    assert.ok(text, 'init --codex creates .codex/hooks.json');
    const json = JSON.parse(text);
    assert.ok(json.hooks && json.hooks.Stop && json.hooks.SessionStart, 'the written file carries baton hooks');

    const skill = io.files()[`${ROOT}/.agents/skills/baton-handoff/SKILL.md`];
    assert.ok(skill, '(W5) init --codex installs .agents/skills/baton-handoff/SKILL.md into the repo');
    assert.ok(skill.includes(SKILL_MARK), '(W5) the installed skill surfaces the packaged template bytes');

    assert.deepEqual(homeCodexKeys(io), [], '(W6) --codex without the legacy flag writes nothing under HOME .codex');
    assert.deepEqual(forbiddenKeys(io), [], '(W6) --codex creates no config.toml / notify file anywhere');
  });

  it('a second `baton init --codex` is a no-op (whole memfs byte-identical)', async () => {
    const io = cmdIo();
    assert.equal(await cmdInit(['--codex'], io), 0);
    const afterFirst = io.files();
    assert.equal(await cmdInit(['--codex'], io), 0);
    assert.deepEqual(io.files(), afterFirst, 'a second init --codex mutates nothing — merge is idempotent');
  });
});
