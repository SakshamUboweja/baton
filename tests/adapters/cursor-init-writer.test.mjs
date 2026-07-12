import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { cmdInit } from '../../core/src/commands/init.mjs';
// SOLE RED CAUSE for this file: harness.mjs does not exist yet, so this static
// import throws ERR_MODULE_NOT_FOUND at load and every test reds with that single
// cause. (makeIo + cmdInit resolve fine.)
import { planHarnessInit } from '../../core/src/scaffold/harness.mjs';

// ---------------------------------------------------------------------------
// ADAPTERS wave — RED. `baton init --cursor` writer contract.
//
// TARGET MODULE: core/src/scaffold/harness.mjs (the same NEW writer home the
// codex writer test pins; docs/design/core.md names no harness writer, so the
// wave brief's default is used — documented in codex-init-writer.test.mjs).
// Keeping the writer logic on this NEW module keeps the RED cause a clean
// ERR_MODULE_NOT_FOUND even though `baton init --cursor` EXTENDS the existing
// core/src/commands/init.mjs.
//
// Source of truth: plan §Cursor adapter ("hooks.json written only after explicit
// confirmation, merged not clobbered") + build order phase 4.
//
// PINNED CONTRACT (see codex-init-writer.test.mjs for the shared W0 signature):
//   V1. --cursor plans a WRITE of <cwd>/.cursor/hooks.json (a {"version":1,…}
//       merge that surfaces the packaged template bytes) PLUS the command +
//       rule surfaces (.cursor/commands/*.md, .cursor/rules/baton-handoff.mdc).
//   V2. MERGE NEVER CLOBBER (verifier fold V7 — deep, ALL events): an existing
//       <cwd>/.cursor/hooks.json is merged — version 1 preserved, and for EVERY
//       baton cursor event (stop, afterFileEdit, beforeShellExecution,
//       sessionStart, preCompact) the pre-existing user entry survives as the
//       EXACT OBJECT (assert.deepStrictEqual against a merged array member, not
//       string inclusion) with the baton entry coexisting in the SAME array; a
//       foreign user event also survives exactly.
//   V3. GATED: planHarnessInit(cwd, {}, io) plans NOTHING under .cursor/.
//   V4. Command wiring (through cmdInit): plain `baton init` NEVER creates
//       .cursor/; `baton init --cursor` creates a valid <root>/.cursor/hooks.json;
//       a second run is a NO-OP (whole memfs byte-identical).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const TPL_DIR = join(repoRoot, 'templates');
const CUR_DIR = join(repoRoot, 'adapters', 'cursor'); // module-resolved packaged templates
const ROOT = '/repo';

// Per-event read-not-embed sentinels: content only reachable by READING the
// packaged template seeded below (V7 needs a distinguishable baton entry per event).
const MARK = {
  stop: 'BATON_CURSOR_STOP_MARK',
  afterFileEdit: 'BATON_CURSOR_AFTERFILEEDIT_MARK',
  beforeShellExecution: 'BATON_CURSOR_BEFORESHELL_MARK',
  sessionStart: 'BATON_CURSOR_SESSIONSTART_MARK',
  preCompact: 'BATON_CURSOR_PRECOMPACT_MARK',
};
const BATON_MARK = MARK.stop;
const CURSOR_HOOKS_TPL = JSON.stringify({
  version: 1,
  hooks: {
    stop: [{ command: `baton checkpoint --platform cursor ${MARK.stop}` }],
    afterFileEdit: [{ command: `baton checkpoint --platform cursor ${MARK.afterFileEdit}` }],
    beforeShellExecution: [{ command: `baton checkpoint --platform cursor ${MARK.beforeShellExecution}`, matcher: 'git commit' }],
    sessionStart: [{ command: `baton receive --print-prompt --platform cursor ${MARK.sessionStart}` }],
    preCompact: [{ command: `baton checkpoint --platform cursor ${MARK.preCompact}` }],
  },
}, null, 2);

/** Exact-object membership: deepStrictEqual against some array member (V7). */
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
const CMD_TPL = (n) => `---\ndescription: baton ${n} command\n---\n\nRun baton ${n}.\n`;
const RULE_TPL = '---\nalwaysApply: true\n---\n\nCheckpoint via baton; resume with baton receive.\n';

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

const CURSOR_TEMPLATES = {
  [join(CUR_DIR, 'hooks.json')]: CURSOR_HOOKS_TPL,
  [join(CUR_DIR, 'commands', 'receive.md')]: CMD_TPL('receive'),
  [join(CUR_DIR, 'commands', 'handoff.md')]: CMD_TPL('handoff'),
  [join(CUR_DIR, 'commands', 'baton-setup.md')]: CMD_TPL('baton-setup'),
  [join(CUR_DIR, 'rules', 'baton-handoff.mdc')]: RULE_TPL,
};

function moduleIo(extra = {}) {
  return makeIo({ files: { ...CURSOR_TEMPLATES, ...extra } });
}
function cmdIo(extra = {}) {
  return makeIo({
    files: {
      [join(TPL_DIR, 'baton.config.json.tpl')]: CONFIG_TPL,
      [join(TPL_DIR, 'AGENTS.md.tpl')]: AGENTS_TPL,
      [join(TPL_DIR, 'CLAUDE.md.tpl')]: CLAUDE_TPL,
      ...CURSOR_TEMPLATES,
      [`${ROOT}/package.json`]: PKG,
      ...extra,
    },
    execResults: GIT_CLEAN,
  });
}
const cursorHooksAction = (actions) => actions.find((a) => /\/\.cursor\/hooks\.json$/.test(a.path));
const cursorActions = (actions) => actions.filter((a) => /\/\.cursor\//.test(a.path));

// ===========================================================================
describe('planHarnessInit(--cursor) — writes hooks + commands + rule (V1)', () => {
  it('plans a version-1 .cursor/hooks.json write plus the command + rule surfaces', () => {
    const io = moduleIo();
    const actions = planHarnessInit(ROOT, { cursor: true }, io);

    const a = cursorHooksAction(actions);
    assert.ok(a && a.op === 'write', 'a .cursor/hooks.json write is planned');
    const cfg = JSON.parse(a.preview);
    assert.equal(cfg.version, 1, 'the written manifest is version 1');
    assert.ok(cfg.hooks.stop && cfg.hooks.sessionStart, 'baton stop + sessionStart hooks are present');
    assert.ok(a.preview.includes(BATON_MARK), 'the packaged template bytes surface (init reads the template)');

    const targets = cursorActions(actions).map((x) => x.path);
    for (const rel of ['/.cursor/commands/receive.md', '/.cursor/commands/handoff.md', '/.cursor/commands/baton-setup.md', '/.cursor/rules/baton-handoff.mdc']) {
      assert.ok(targets.some((t) => t.endsWith(rel)), `--cursor plans the ${rel} surface`);
    }
  });
});

// ===========================================================================
describe('planHarnessInit(--cursor) — merge never clobbers user hooks (V2, V7 deep + all events)', () => {
  it('version 1 preserved; EXACT user entries survive for EVERY baton event with the baton entry coexisting', () => {
    const USER = {
      stop: { command: 'USER_STOP_HOOK' },
      afterFileEdit: { command: 'USER_AFTERFILEEDIT_HOOK' },
      beforeShellExecution: { command: 'USER_BEFORESHELL_HOOK', matcher: 'rm -rf' },
      sessionStart: { command: 'USER_SESSIONSTART_HOOK', timeout: 9 },
      preCompact: { command: 'USER_PRECOMPACT_HOOK' },
      afterAgentResponse: { command: 'USER_FOREIGN_HOOK' },
    };
    const existing = JSON.stringify({
      version: 1,
      hooks: {
        stop: [USER.stop],
        afterFileEdit: [USER.afterFileEdit],
        beforeShellExecution: [USER.beforeShellExecution],
        sessionStart: [USER.sessionStart],
        preCompact: [USER.preCompact],
        afterAgentResponse: [USER.afterAgentResponse],
      },
    });
    const io = moduleIo({ [`${ROOT}/.cursor/hooks.json`]: existing });

    const a = cursorHooksAction(planHarnessInit(ROOT, { cursor: true }, io));
    assert.ok(a && a.op === 'write', 'merging an existing file plans a write');
    const cfg = JSON.parse(a.preview);
    assert.equal(cfg.version, 1, 'version 1 is preserved through the merge');

    // Foreign user event survives as the exact object.
    assert.ok(deepIncludes(cfg.hooks.afterAgentResponse, USER.afterAgentResponse), 'a foreign user event survives deep-equal (never clobbered)');

    // For EVERY baton cursor event: exact user entry survives AND baton's coexists.
    for (const ev of ['stop', 'afterFileEdit', 'beforeShellExecution', 'sessionStart', 'preCompact']) {
      assert.ok(deepIncludes(cfg.hooks[ev], USER[ev]), `(V7) the user's ${ev} entry survives as the EXACT object (deepStrictEqual member)`);
      assert.ok(JSON.stringify(cfg.hooks[ev]).includes(MARK[ev]), `(V7) baton's ${ev} entry coexists in the same array`);
    }
  });
});

// ===========================================================================
describe('planHarnessInit — gated behind the flag (V3)', () => {
  it('with no harness flags, nothing under .cursor/ is planned', () => {
    const actions = planHarnessInit(ROOT, {}, moduleIo());
    assert.equal(cursorActions(actions).length, 0, 'plain init plans no .cursor/ surface');
  });
});

// ===========================================================================
describe('baton init --cursor — command gating + no-op double run (V4)', () => {
  it('plain `baton init` NEVER creates .cursor/', async () => {
    const io = cmdIo();
    assert.equal(await cmdInit([], io), 0, `init should succeed; stderr: ${io.stderrText()}`);
    assert.equal(io.files()[`${ROOT}/.cursor/hooks.json`], undefined, 'plain init leaves .cursor/ uncreated (gated behind --cursor)');
  });

  it('`baton init --cursor` creates a valid .cursor/hooks.json', async () => {
    const io = cmdIo();
    assert.equal(await cmdInit(['--cursor'], io), 0, `init --cursor should succeed; stderr: ${io.stderrText()}`);
    const text = io.files()[`${ROOT}/.cursor/hooks.json`];
    assert.ok(text, 'init --cursor creates .cursor/hooks.json');
    const cfg = JSON.parse(text);
    assert.equal(cfg.version, 1);
    assert.ok(cfg.hooks.stop && cfg.hooks.sessionStart, 'the written file carries baton hooks');
  });

  it('a second `baton init --cursor` is a no-op (whole memfs byte-identical)', async () => {
    const io = cmdIo();
    assert.equal(await cmdInit(['--cursor'], io), 0);
    const afterFirst = io.files();
    assert.equal(await cmdInit(['--cursor'], io), 0);
    assert.deepEqual(io.files(), afterFirst, 'a second init --cursor mutates nothing — merge is idempotent');
  });
});
