import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { cmdInit } from '../../core/src/commands/init.mjs';

// ---------------------------------------------------------------------------
// Command-level contract for core/src/commands/init.mjs — the two-phase
// plan/apply scaffolder. Direct import over fakeio (mirrors cmdReceive/
// cmdFinalize): cmdInit(args, io) -> exit code (awaited; init may refresh git
// via the async injected execFile, so it is treated as async).
//
// TARGET MODULE: core/src/commands/init.mjs (sole target — its absence is the
// only reason this file is RED). The pure scaffold transforms it composes
// (scaffold/gitignore.mjs, scaffold/managed-block.mjs, scaffold/attribution.mjs,
// scaffold/plan.mjs) are unit-tested in their own files; THIS file pins the
// COMMAND behaviour — two-phase plan/apply, --dry-run, idempotency — through the
// observable filesystem, exactly as finalize.test.mjs pins rotation through the
// command rather than re-importing store internals.
//
// Source of truth: plan §Scaffold ("two-phase plan/apply with --dry-run;
// .gitignore ensure-line (no-op if an existing pattern covers .handoff/);
// baton.config.json from template; AGENTS.md/CLAUDE.md written via managed blocks
// (<!-- baton:begin/end -->) — bytes outside markers never touched") and
// §Attribution guard layer 1 (deep-merge .claude/settings.json; refuses malformed
// JSON); docs/design/core.md §scaffold test list ("--dry-run zero writes").
//
// PINS (where the plan/design left the command surface open):
//   I1. ROOT = io.cwd (same as every other command; /repo under fakeio).
//   I2. TEMPLATE SOURCING. init sources the AGENTS.md / CLAUDE.md managed-block
//       bodies and the baton.config.json content from the packaged `templates/`
//       directory, resolved relative to the module via import.meta.url EXACTLY as
//       detect/signatures.mjs resolves data/signatures.v1.json (<repoRoot>/
//       templates/{AGENTS.md.tpl, CLAUDE.md.tpl, baton.config.json.tpl}), and
//       reads them through the injected io.fs. These tests therefore seed those
//       template files into the memfs at their module-resolved absolute paths.
//       The template BODIES here are minimal and placeholder-free, and (verifier
//       fold F4) the seeded CONTENT must SURFACE in the written files: init MUST
//       read the packaged templates, not embed its own defaults — the scaffolded
//       baton.config.json parses deep-equal to the config template, and each
//       managed block carries its seeded template body verbatim.
//   I3. FRESH APPLY (no --dry-run) creates, under <root>:
//         - baton.config.json : valid JSON, schema "baton/config@1", parsed
//           content deep-equal to the packaged template (F4)
//         - .gitignore        : contains a line covering .handoff/
//         - AGENTS.md, CLAUDE.md : each contains BOTH managed markers with the
//           seeded template body between them (F4)
//         - .claude/settings.json : attribution.commit === "" and .pr === ""
//       and exits 0.
//   I4. --dry-run is PLAN-ONLY: exit 0, a human-readable plan naming the actions,
//       and the ENTIRE memfs is byte-identical before/after (io.files() deep-
//       equal) — ZERO writes. This is the two-phase guarantee.
//   I5. IDEMPOTENT: a second apply is all-no-ops — the full memfs after run 2 is
//       byte-identical to after run 1.
//   I6. .gitignore COVERING NO-OP: a pre-existing line covering .handoff/ makes
//       the .gitignore action a byte-identical no-op.
//   I7. MANAGED-BLOCK OUTSIDE-BYTES INVARIANCE: for a file that already has the
//       markers with surrounding user content, the bytes before the begin marker
//       and after the end marker are byte-for-byte identical after init.
//   I8. ATTRIBUTION MALFORMED-REFUSE: a malformed .claude/settings.json is NEVER
//       rewritten (byte-identical afterward) and init surfaces a warning naming
//       it, while the rest of the scaffold still applies; exit 0.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const TPL_DIR = join(repoRoot, 'templates');

const BEGIN = '<!-- baton:begin -->';
const END = '<!-- baton:end -->';
const ROOT = '/repo';

// Minimal, placeholder-free templates seeded at the module-resolved paths (I2).
const CONFIG_TPL = JSON.stringify(
  {
    schema: 'baton/config@1',
    roles: { planner: ['claude-code/claude-fable-5'] },
    platforms: { 'claude-code': {}, codex: {}, cursor: {} },
    defaults: { 'claude-code': 'claude-fable-5', codex: 'gpt-5.6-sol', cursor: 'composer' },
  },
  null,
  2,
);
const AGENTS_TPL = '## Handoff protocol\n\nCheckpoint after each completed subtask.\n';
const CLAUDE_TPL = '@AGENTS.md\n\n- Prefer /baton:* commands.\n';

const GIT_CLEAN = {
  'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
  'git rev-parse HEAD': { stdout: 'abc123\n' },
  'git status --porcelain': { stdout: '' },
  'git diff --cached': { stdout: '' },
  'git diff': { stdout: '' },
  'git ls-files --others --exclude-standard': { stdout: '' },
};

/** A minimal package.json so any test-command detection has something to read. */
const PKG = JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } });

function seedIo(extra = {}) {
  return makeIo({
    files: {
      [join(TPL_DIR, 'baton.config.json.tpl')]: CONFIG_TPL,
      [join(TPL_DIR, 'AGENTS.md.tpl')]: AGENTS_TPL,
      [join(TPL_DIR, 'CLAUDE.md.tpl')]: CLAUDE_TPL,
      [`${ROOT}/package.json`]: PKG,
      ...extra,
    },
    execResults: GIT_CLEAN,
  });
}

const read = (io, rel) => io.files()[`${ROOT}/${rel}`];

// ===========================================================================
describe('init — fresh apply scaffolds every surface', () => {
  it('creates a valid baton.config.json, a covering .gitignore, marked AGENTS.md/CLAUDE.md, and attribution settings; exit 0', async () => {
    const io = seedIo();
    const code = await cmdInit([], io);
    assert.equal(code, 0, `init should succeed; stderr: ${io.stderrText()}`);

    const cfgText = read(io, 'baton.config.json');
    assert.ok(cfgText, 'baton.config.json is created');
    const cfg = JSON.parse(cfgText);
    assert.equal(cfg.schema, 'baton/config@1', 'the scaffolded config carries the config schema');
    // (F4) The config CONTENT is the packaged template, not an embedded default.
    assert.deepEqual(cfg, JSON.parse(CONFIG_TPL), 'the scaffolded config parses deep-equal to the packaged template — init must read templates/');

    const gitignore = read(io, '.gitignore');
    assert.ok(gitignore, '.gitignore is created');
    assert.ok(
      gitignore.split(/\r?\n/).some((l) => l.trim() === '.handoff/' || l.trim() === '.handoff'),
      '.gitignore contains a line covering .handoff/',
    );

    // (F4) Each managed block carries its seeded template body — a template the
    // implementation never read could not surface these exact bytes.
    const tplFor = { 'AGENTS.md': AGENTS_TPL, 'CLAUDE.md': CLAUDE_TPL };
    for (const doc of ['AGENTS.md', 'CLAUDE.md']) {
      const body = read(io, doc);
      assert.ok(body, `${doc} is created`);
      assert.ok(body.includes(BEGIN) && body.includes(END), `${doc} carries both managed markers`);
      const block = body.slice(body.indexOf(BEGIN) + BEGIN.length, body.indexOf(END));
      assert.ok(block.includes(tplFor[doc].trim()), `${doc}'s managed block carries the packaged template body verbatim`);
    }

    const settings = JSON.parse(read(io, '.claude/settings.json'));
    assert.equal(settings.attribution.commit, '', 'attribution.commit is set to the empty string');
    assert.equal(settings.attribution.pr, '', 'attribution.pr is set to the empty string');
  });
});

// ===========================================================================
describe('init — --dry-run is plan-only (zero writes)', () => {
  it('prints a plan, exits 0, and mutates NOTHING (full memfs byte-identical)', async () => {
    const io = seedIo();
    const before = io.files();

    const code = await cmdInit(['--dry-run'], io);
    assert.equal(code, 0);

    const out = `${io.stdoutText()}${io.stderrText()}`;
    // The plan half of two-phase: it must describe the actions it WOULD take.
    assert.match(out, /baton\.config\.json/, 'the plan names the config it would write');
    assert.match(out, /\.gitignore/, 'the plan names the .gitignore action');

    assert.deepEqual(io.files(), before, '--dry-run must not write anything anywhere (two-phase plan-only)');
  });

  it('--dry-run does not create .claude/settings.json either', async () => {
    const io = seedIo();
    await cmdInit(['--dry-run'], io);
    assert.equal(read(io, '.claude/settings.json'), undefined, 'no attribution file is written during a dry run');
  });

  // Field finding: a stray token after --dry-run (e.g. a pasted `# comment`
  // zsh does not strip) was consumed as the flag's VALUE, `=== true` failed,
  // and the "preview" ran a REAL init. A safety flag must fail safe: presence
  // wins, the stray value is warned about and ignored.
  it('--dry-run with a stray trailing token is STILL a dry run (zero writes) and warns', async () => {
    const io = seedIo();
    const before = io.files();
    const code = await cmdInit(['--dry-run', '#', 'preview'], io);
    assert.equal(code, 0);
    assert.deepEqual(io.files(), before, 'a garbled --dry-run must never fall through to a real init');
    assert.match(io.stdoutText(), /dry run/, 'the dry-run banner still prints');
    assert.match(io.stderrText(), /ignoring unexpected value/i, 'the stray token is surfaced, not silently eaten');
  });

  it('--check with a stray trailing token is STILL check mode (read-only)', async () => {
    const io = seedIo();
    const before = io.files();
    const code = await cmdInit(['--check', 'foo'], io);
    assert.deepEqual(io.files(), before, 'a garbled --check must stay read-only');
    assert.equal(code, 1, 'an unscaffolded tree is drift — check mode exits 1, it does not scaffold');
  });
});

// ===========================================================================
describe('init — idempotency (double-run = all no-ops)', () => {
  it('a second apply leaves the entire memfs byte-identical to the first', async () => {
    const io = seedIo();

    const first = await cmdInit([], io);
    assert.equal(first, 0);
    const afterFirst = io.files();

    const second = await cmdInit([], io);
    assert.equal(second, 0);

    assert.deepEqual(io.files(), afterFirst, 'a second init is entirely no-ops — byte-identical filesystem');
  });
});

// ===========================================================================
describe('init — .gitignore covering no-op', () => {
  it('an existing line covering .handoff/ leaves .gitignore byte-identical', async () => {
    const existing = '.handoff/\nnode_modules/\ncoverage/\n';
    const io = seedIo({ [`${ROOT}/.gitignore`]: existing });

    const code = await cmdInit([], io);
    assert.equal(code, 0);
    assert.equal(read(io, '.gitignore'), existing, 'a .gitignore already covering .handoff/ is not rewritten');
  });
});

// ===========================================================================
describe('init — managed-block outside-bytes invariance', () => {
  it('replacing an existing managed block preserves the user bytes above and below it', async () => {
    const TOP = '# AGENTS\n\nUser-owned preamble.\n';
    const BOTTOM = '\n## User section below the block\n\nMore user bytes.\n';
    const seeded = `${TOP}${BEGIN}\nOLD MANAGED BODY\n${END}${BOTTOM}`;
    const io = seedIo({ [`${ROOT}/AGENTS.md`]: seeded });

    const code = await cmdInit([], io);
    assert.equal(code, 0);

    const out = read(io, 'AGENTS.md');
    assert.equal(out.slice(0, out.indexOf(BEGIN)), TOP, 'bytes before the begin marker are untouched');
    assert.equal(out.slice(out.indexOf(END) + END.length), BOTTOM, 'bytes after the end marker are untouched');
    assert.ok(out.includes(BEGIN) && out.includes(END), 'the markers remain');
  });
});

// ===========================================================================
describe('init — attribution refuses malformed settings', () => {
  it('a malformed .claude/settings.json is left byte-identical, a warning names it, and the rest still scaffolds; exit 0', async () => {
    const malformed = '{ this is not: valid json';
    const io = seedIo({ [`${ROOT}/.claude/settings.json`]: malformed });

    const code = await cmdInit([], io);
    assert.equal(code, 0, 'a malformed optional settings file does not fail the whole scaffold');

    assert.equal(read(io, '.claude/settings.json'), malformed, 'init NEVER rewrites a settings file it cannot parse');
    assert.match(io.stderrText(), /settings\.json|attribution|malformed|parse|skip/i, 'a warning explains the untouched settings file');

    // The rest of the scaffold still applied.
    assert.ok(read(io, 'baton.config.json'), 'the config is still scaffolded despite the malformed settings');
  });
});

// ===========================================================================
describe('init — --json envelope', () => {
  it('emits exactly one compact {ok:true,...} envelope on stdout', async () => {
    const io = seedIo();
    const code = await cmdInit(['--json'], io);
    assert.equal(code, 0);

    const parsed = JSON.parse(io.stdoutText());
    assert.equal(io.stdoutText(), JSON.stringify(parsed) + '\n', 'stdout is exactly one compact envelope + newline');
    assert.equal(parsed.ok, true);
    assert.ok('data' in parsed && 'warnings' in parsed && 'error' in parsed, 'the envelope carries data/warnings/error');
  });
});
