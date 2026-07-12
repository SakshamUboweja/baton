import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { planHarnessInit } from '../../core/src/scaffold/harness.mjs';

// ---------------------------------------------------------------------------
// PATH-independence of hook commands (post-Gate-2 field finding).
//
// A GUI-launched harness (Cursor / Codex desktop app) runs its hook commands
// with a minimal PATH that omits nvm/volta shims, so a bare `baton …` command
// resolves to "command not found" and the checkpoint silently no-ops — observed
// live on lesson-gate: the Cursor `stop` hook never fired. The fix: `baton init`
// embeds an absolute `"<node>" "<baton.mjs>"` invocation, which needs no PATH.
//
// These tests run the REAL packaged adapter templates through the writer so
// template drift (e.g. a future bare-`baton` entry) reds here.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const CODEX_TPL = join(repoRoot, 'adapters', 'codex', 'hooks.json');
const CURSOR_TPL = join(repoRoot, 'adapters', 'cursor', 'hooks.json');
const BATON_ENTRY = join(repoRoot, 'core', 'bin', 'baton.mjs');
const FAKE_NODE = '/opt/fake/nvm/v24/bin/node';
const ROOT = '/repo';

// Seed the REAL packaged template bytes into memfs at their module-resolved paths.
const realTemplates = {
  [CODEX_TPL]: readFileSync(CODEX_TPL, 'utf8'),
  [CURSOR_TPL]: readFileSync(CURSOR_TPL, 'utf8'),
};
function io(extra = {}) {
  return makeIo({ files: { ...realTemplates, ...extra }, env: { HOME: '/home/u' }, execPath: FAKE_NODE });
}
const hooksAction = (actions, plat) => actions.find((a) => a.path.endsWith(`/.${plat}/hooks.json`));

/** Every command / commandWindows string in a parsed manifest. */
function allCommands(manifest) {
  /** @type {string[]} */
  const out = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      for (const [k, v] of Object.entries(n)) {
        if ((k === 'command' || k === 'commandWindows') && typeof v === 'string') out.push(v);
        else walk(v);
      }
    }
  };
  walk(manifest.hooks ?? {});
  return out;
}

for (const [plat, flag] of [['codex', 'codex'], ['cursor', 'cursor']]) {
  describe(`baton init --${flag} — hook commands are absolute (PATH-independent)`, () => {
    it('every command embeds the injected node binary + absolute baton.mjs, never a bare `baton`', () => {
      const a = hooksAction(planHarnessInit(ROOT, { [flag]: true }, io()), plat);
      assert.ok(a && a.op === 'write', `a .${plat}/hooks.json write is planned`);
      const cmds = allCommands(JSON.parse(a.preview));
      assert.ok(cmds.length > 0, 'the manifest carries hook commands');
      for (const c of cmds) {
        assert.ok(c.includes(`"${FAKE_NODE}"`), `command embeds the absolute node binary — got: ${c}`);
        assert.ok(c.includes(`"${BATON_ENTRY}"`), `command embeds the absolute baton.mjs script — got: ${c}`);
        // No token is a bare `baton` (would depend on PATH). The only `baton`
        // substring allowed is inside the quoted absolute baton.mjs path.
        assert.ok(!/(^|\s)baton(\s|$)/.test(c), `no bare \`baton\` command word survives — got: ${c}`);
      }
    });

    it('resolves as an executable pair: first token = node binary, second = baton.mjs', () => {
      const a = hooksAction(planHarnessInit(ROOT, { [flag]: true }, io()), plat);
      const cmds = allCommands(JSON.parse(a.preview)).filter((c) => !c.startsWith('cmd /c'));
      const m = cmds[0].match(/^"([^"]+)"\s+"([^"]+)"/);
      assert.ok(m, `command starts with two quoted absolute paths — got: ${cmds[0]}`);
      assert.equal(m[1], FAKE_NODE, 'first token is the absolute node binary');
      assert.ok(m[2].endsWith('/core/bin/baton.mjs'), 'second token is the absolute baton entry script');
    });

    it('re-init REPLACES a stale bare-`baton` entry — no duplicate, no lingering PATH-dependent command', () => {
      const stale = plat === 'codex'
        ? { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'baton checkpoint --platform codex' }] }] } }
        : { version: 1, hooks: { stop: [{ command: 'baton checkpoint --platform cursor' }] } };
      const a = hooksAction(planHarnessInit(ROOT, { [flag]: true }, io({ [`${ROOT}/.${plat}/hooks.json`]: JSON.stringify(stale) })), plat);
      assert.ok(a && a.op === 'write', 're-init over a stale bare entry plans a write (the replacement)');
      const cmds = allCommands(JSON.parse(a.preview));
      assert.ok(!cmds.some((c) => c === 'baton checkpoint --platform ' + plat), 'the stale bare-`baton` command is gone (replaced, not duplicated)');
      assert.ok(cmds.every((c) => c.includes(`"${BATON_ENTRY}"`)), 'every surviving baton command is absolute');
    });

    it('preserves a user hook while rewriting baton’s own', () => {
      const userEntry = plat === 'codex'
        ? { hooks: [{ type: 'command', command: 'USER_KEEP_ME' }] }
        : { command: 'USER_KEEP_ME' };
      const ev = plat === 'codex' ? 'Stop' : 'stop';
      const existing = plat === 'codex'
        ? { hooks: { [ev]: [userEntry] } }
        : { version: 1, hooks: { [ev]: [userEntry] } };
      const a = hooksAction(planHarnessInit(ROOT, { [flag]: true }, io({ [`${ROOT}/.${plat}/hooks.json`]: JSON.stringify(existing) })), plat);
      const merged = JSON.parse(a.preview);
      assert.ok(JSON.stringify(merged.hooks[ev]).includes('USER_KEEP_ME'), 'the user entry survives the merge');
      assert.ok(allCommands(merged).some((c) => c.includes(`"${BATON_ENTRY}"`)), 'baton’s own entry is present and absolute');
    });

    it('a second init is a byte-identical no-op (idempotent under the deterministic invocation)', () => {
      const first = hooksAction(planHarnessInit(ROOT, { [flag]: true }, io()), plat);
      const seeded = io({ [`${ROOT}/.${plat}/hooks.json`]: first.preview });
      const second = hooksAction(planHarnessInit(ROOT, { [flag]: true }, seeded), plat);
      assert.equal(second.op, 'skip', 'the second init changes nothing');
    });
  });
}
