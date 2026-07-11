import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { loadConfig } from '../../core/src/roles/matrix.mjs';

// ===========================================================================
// Contract choices for roles/matrix.mjs. Source of truth: docs/design/core.md
// §Module APIs (loadConfig(cwd, io) -> {config, errors[]}); plan §Core engine —
// Role matrix; baton.config.json at the repo root (the real example, whose
// roles are ARRAYS of "platform/model[@effort]" chain-entry strings).
//
// PINS:
//   1. loadConfig reads `<cwd>/baton.config.json` via io.fs. It returns
//      {config, errors} — never throws on bad input. `errors` is a
//      {path, msg}[] array (same shape as validateBundle in schema.mjs);
//      empty when the config is fully valid.
//   2. CHAIN-ENTRY PARSING. Each role chain string is parsed into a structured
//      entry: "platform/model"       -> {platform, model, effort: null}
//                "platform/model@eff" -> {platform, model, effort: 'eff'}.
//      Split on the FIRST '/' (platform names contain '-' but never '/'); the
//      remainder splits on '@' into model + effort. Models keep '.'/'-'
//      (e.g. gpt-5.6-sol). config.roles becomes {[role]: Entry[]}.
//   3. PASSTHROUGH. config.schema, config.platforms, config.defaults (and other
//      top-level keys) survive onto the returned config; the resolver consumes
//      platforms + defaults.
//   4. PATHED ERRORS (path strings pinned as a contract):
//        - config file missing entirely  -> config null; an error whose msg
//          names 'baton.config.json'.
//        - unparseable JSON               -> config null; an error naming the file.
//        - missing `roles` key            -> error path 'roles'.
//        - a role chain that is not an array -> error path 'roles.<role>'.
//        - a malformed entry (no '/')     -> error path 'roles.<role>[<i>]'.
//        - an entry whose platform is not a key of config.platforms
//                                          -> error path 'roles.<role>[<i>]',
//                                             msg mentioning the platform.
//   5. FORWARD-COMPAT. Unknown ROLE NAMES (not one of the seven methodology
//      roles) are TOLERATED — no error; the unknown role is still parsed.
// ===========================================================================

const CWD = '/repo';
const CONFIG_PATH = '/repo/baton.config.json';

function ioWithConfig(obj) {
  const files = obj === undefined ? {} : { [CONFIG_PATH]: typeof obj === 'string' ? obj : JSON.stringify(obj) };
  return makeIo({ files });
}

// The real repo config, as an object (roles still in chain-entry STRING form).
function realConfigObject() {
  return {
    schema: 'baton/config@1',
    roles: {
      planner: ['claude-code/claude-fable-5'],
      'plan-reviewer': ['codex/gpt-5.6-sol@xhigh', 'claude-code/claude-fable-5@xhigh'],
      'test-author': ['claude-code/claude-opus-4-8', 'codex/gpt-5.5@xhigh'],
      'test-verifier': ['codex/gpt-5.5@xhigh', 'claude-code/claude-opus-4-8'],
      implementer: ['claude-code/claude-fable-5', 'codex/gpt-5.6-sol@xhigh', 'cursor/composer'],
      'final-reviewer-a': ['codex/gpt-5.6-sol@xhigh', 'codex/gpt-5.5@xhigh'],
      'final-reviewer-b': ['claude-code/claude-fable-5@xhigh', 'claude-code/claude-opus-4-8'],
    },
    platforms: { 'claude-code': {}, codex: {}, cursor: {} },
    defaults: { 'claude-code': 'claude-fable-5', codex: 'gpt-5.6-sol', cursor: 'composer' },
  };
}

// ---------------------------------------------------------------------------
describe('matrix.loadConfig — valid config parsing', () => {
  it('parses the real repo config with no errors', () => {
    const io = ioWithConfig(realConfigObject());
    const { config, errors } = loadConfig(CWD, io);
    assert.deepEqual(errors, [], `expected no errors, got ${JSON.stringify(errors)}`);
    assert.ok(config, 'config must be returned');
    assert.equal(config.schema, 'baton/config@1');
  });

  it('parses "platform/model" into {platform, model, effort:null}', () => {
    const io = ioWithConfig(realConfigObject());
    const { config } = loadConfig(CWD, io);
    assert.deepEqual(config.roles.planner, [{ platform: 'claude-code', model: 'claude-fable-5', effort: null }]);
  });

  it('parses "platform/model@effort" (model keeps dots/hyphens) into a full entry', () => {
    const io = ioWithConfig(realConfigObject());
    const { config } = loadConfig(CWD, io);
    assert.deepEqual(config.roles['plan-reviewer'][0], { platform: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' });
  });

  it('parses a mixed chain (effort present + absent) end to end', () => {
    const io = ioWithConfig(realConfigObject());
    const { config } = loadConfig(CWD, io);
    assert.deepEqual(config.roles['test-author'], [
      { platform: 'claude-code', model: 'claude-opus-4-8', effort: null },
      { platform: 'codex', model: 'gpt-5.5', effort: 'xhigh' },
    ]);
  });

  it('passes platforms and defaults through onto the returned config', () => {
    const io = ioWithConfig(realConfigObject());
    const { config } = loadConfig(CWD, io);
    assert.deepEqual(Object.keys(config.platforms).sort(), ['claude-code', 'codex', 'cursor']);
    assert.equal(config.defaults.codex, 'gpt-5.6-sol');
    assert.equal(config.defaults['claude-code'], 'claude-fable-5');
    assert.equal(config.defaults.cursor, 'composer');
  });
});

// ---------------------------------------------------------------------------
describe('matrix.loadConfig — missing / unparseable file', () => {
  it('missing baton.config.json -> config null + an error naming the file', () => {
    const io = ioWithConfig(undefined); // empty fs, no config
    const { config, errors } = loadConfig(CWD, io);
    assert.equal(config, null);
    assert.ok(errors.length > 0, 'must report at least one error');
    assert.ok(errors.some((e) => /baton\.config\.json/.test(e.msg)), 'an error must name baton.config.json');
  });

  it('unparseable JSON -> config null + an error naming the file', () => {
    const io = ioWithConfig('{ this is not: valid json ]');
    const { config, errors } = loadConfig(CWD, io);
    assert.equal(config, null);
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => /baton\.config\.json/.test(e.msg)));
  });
});

// ---------------------------------------------------------------------------
describe('matrix.loadConfig — pathed validation errors', () => {
  it('missing roles key -> error at path "roles"', () => {
    const cfg = realConfigObject();
    delete cfg.roles;
    const { errors } = loadConfig(CWD, ioWithConfig(cfg));
    assert.ok(errors.some((e) => e.path === 'roles'), `expected an error at path "roles", got ${JSON.stringify(errors)}`);
  });

  it('a non-array role chain -> error at path "roles.<role>"', () => {
    const cfg = realConfigObject();
    cfg.roles.planner = 'claude-code/claude-fable-5'; // string, not an array
    const { errors } = loadConfig(CWD, ioWithConfig(cfg));
    assert.ok(errors.some((e) => e.path === 'roles.planner'), `expected error at "roles.planner", got ${JSON.stringify(errors)}`);
  });

  it('a malformed entry with no "/" -> error at path "roles.<role>[<i>]"', () => {
    const cfg = realConfigObject();
    cfg.roles.planner = ['claudecode-no-slash'];
    const { errors } = loadConfig(CWD, ioWithConfig(cfg));
    assert.ok(errors.some((e) => e.path === 'roles.planner[0]'), `expected error at "roles.planner[0]", got ${JSON.stringify(errors)}`);
  });

  it('an entry naming an unknown platform (not in config.platforms) -> pathed error mentioning the platform', () => {
    const cfg = realConfigObject();
    cfg.roles.planner = ['vscode/copilot'];
    const { errors } = loadConfig(CWD, ioWithConfig(cfg));
    const hit = errors.find((e) => e.path === 'roles.planner[0]');
    assert.ok(hit, `expected error at "roles.planner[0]", got ${JSON.stringify(errors)}`);
    assert.match(hit.msg, /platform|vscode/i);
  });
});

// ---------------------------------------------------------------------------
describe('matrix.loadConfig — forward-compat', () => {
  it('tolerates an unknown ROLE name (no error) and still parses its chain', () => {
    const cfg = realConfigObject();
    cfg.roles['future-role'] = ['codex/gpt-5.5@xhigh'];
    const { config, errors } = loadConfig(CWD, ioWithConfig(cfg));
    assert.deepEqual(errors, [], `unknown role names must not produce errors, got ${JSON.stringify(errors)}`);
    assert.deepEqual(config.roles['future-role'], [{ platform: 'codex', model: 'gpt-5.5', effort: 'xhigh' }]);
  });
});
