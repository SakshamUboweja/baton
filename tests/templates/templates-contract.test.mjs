import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { planInit } from '../../core/src/scaffold/plan.mjs';
import { cmdInit } from '../../core/src/commands/init.mjs';

// ---------------------------------------------------------------------------
// Gate-2 fix 9 (reviewer-a finding 13): the shipped AGENTS.md.tpl carried a
// handoff section only — the plan mandates the full ten-section operating
// contract within hard budgets (AGENTS <= 220 lines, handoff section <= 25;
// CLAUDE.md an @AGENTS.md shim with <= 8 bullets), {{VAR}}-filled by init from
// detection, plus an `init --check` drift gate for CI.
//
// These tests read the REAL packaged templates (no fixtures) — they are the
// enforced budget from the plan §Templates.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const TPL_DIR = join(here, '..', '..', 'templates');
const AGENTS = readFileSync(join(TPL_DIR, 'AGENTS.md.tpl'), 'utf8');
const CLAUDE = readFileSync(join(TPL_DIR, 'CLAUDE.md.tpl'), 'utf8');
const CONFIG = readFileSync(join(TPL_DIR, 'baton.config.json.tpl'), 'utf8');

// planInit reads the packaged templates through io.fs, so the REAL template
// bytes are seeded into the fake at their packaged paths (read-not-embed).
const seedFiles = (extra = {}) => ({
  [join(TPL_DIR, 'AGENTS.md.tpl')]: AGENTS,
  [join(TPL_DIR, 'CLAUDE.md.tpl')]: CLAUDE,
  [join(TPL_DIR, 'baton.config.json.tpl')]: CONFIG,
  ...extra,
});

// The ten mandated sections (plan §Templates), as heading fragments.
const SECTIONS = [
  /^##.*project/im,
  /^##.*roles and models/im,
  /^##.*working phases/im,
  /^##.*tdd/im,
  /^##.*review gates/im,
  /^##.*handoff/im,
  /^##.*boundaries/im,
  /^##.*validation/im,
  /^##.*git and attribution/im,
  /^##.*memory/im,
];

/** Lines of the section starting at the given heading regex, up to the next `## `. */
function sectionLines(text, headingRe) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => headingRe.test(l));
  assert.notEqual(start, -1, `section ${headingRe} exists`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

describe('AGENTS.md.tpl — ten-section contract within budgets', () => {
  it('carries all ten mandated sections', () => {
    for (const re of SECTIONS) assert.match(AGENTS, re, `missing section ${re}`);
  });

  it('fits the 220-line budget; the handoff section fits 25 lines', () => {
    assert.ok(AGENTS.split('\n').length <= 220, `AGENTS.md.tpl is ${AGENTS.split('\n').length} lines (budget 220)`);
    assert.ok(sectionLines(AGENTS, /^##.*handoff/i).length <= 25, 'handoff section exceeds its 25-line budget');
  });

  it('states the attribution invariant, commit cadence, and never-commit-.handoff', () => {
    assert.match(AGENTS, /NEVER.*(AI attribution|Co-Authored-By)/is, 'the zero-AI-attribution invariant is stated');
    assert.match(AGENTS, /commit after every completed subtask/i);
    assert.match(AGENTS, /NEVER commit `?\.handoff/i);
  });

  it('review gates carry the 5-iteration hard cap', () => {
    assert.match(sectionLines(AGENTS, /^##.*review gates/i).join('\n'), /5 iterations/i);
  });

  it('roles section points at the resolver, never hardcoded model names', () => {
    const s = sectionLines(AGENTS, /^##.*roles and models/i).join('\n');
    assert.match(s, /baton remap/);
    assert.match(s, /[Nn]ever hardcode model names/);
  });

  it('uses {{TEST_CMD}} in validation so init can fill it from detection', () => {
    assert.match(sectionLines(AGENTS, /^##.*validation/i).join('\n'), /\{\{TEST_CMD\}\}/);
  });
});

describe('CLAUDE.md.tpl — @AGENTS.md shim', () => {
  it('first line is the @AGENTS.md import', () => {
    assert.equal(CLAUDE.split('\n')[0].trim(), '@AGENTS.md');
  });

  it('has at most 8 bullets and stays a shim (<= 20 lines)', () => {
    const bullets = CLAUDE.split('\n').filter((l) => /^\s*-\s/.test(l));
    assert.ok(bullets.length <= 8, `${bullets.length} bullets (budget 8)`);
    assert.ok(CLAUDE.split('\n').length <= 20, 'CLAUDE.md.tpl must stay a shim');
  });
});

describe('planInit — {{VAR}} filling from detection', () => {
  it('fills TEST_CMD from package.json scripts.test and leaves no {{ in previews', () => {
    const io = makeIo({ files: seedFiles({ '/repo/package.json': JSON.stringify({ name: 'demo-app', scripts: { test: 'node --test' } }) }) });
    const actions = planInit('/repo', {}, io);
    const agents = actions.find((a) => a.id === 'agents');
    assert.equal(agents.op, 'write');
    assert.match(agents.preview, /npm test/);
    for (const a of actions) {
      if (typeof a.preview === 'string') assert.doesNotMatch(a.preview, /\{\{/, `${a.id} preview still contains an unfilled {{VAR}}`);
    }
  });

  it('falls back to an explicit fill-me hint when nothing is detectable', () => {
    const io = makeIo({ files: seedFiles({ '/repo/x.txt': 'x' }) });
    const agents = planInit('/repo', {}, io).find((a) => a.id === 'agents');
    assert.doesNotMatch(agents.preview, /\{\{/);
  });
});

describe('init --check — CI drift gate', () => {
  const seeded = () => makeIo({ files: seedFiles({ '/repo/package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }) }) });

  it('fails before init (everything would be written), passes right after init', async () => {
    const io = seeded();
    assert.equal(await cmdInit(['--check', '--root', '/repo'], io), 1, 'a fresh tree drifts by definition');

    const io2 = seeded();
    assert.equal(await cmdInit(['--root', '/repo'], io2), 0);
    const before = io2.files();
    assert.equal(await cmdInit(['--check', '--root', '/repo'], io2), 0, 'freshly scaffolded tree has no drift');
    assert.deepEqual(io2.files(), before, '--check is read-only');
  });

  it('detects drift inside a managed block', async () => {
    const io = seeded();
    await cmdInit(['--root', '/repo'], io);
    const tampered = io.fs.readFileSync('/repo/AGENTS.md', 'utf8').replace('baton remap', 'hardcoded-model');
    io.fs.writeFileSync('/repo/AGENTS.md', tampered);
    assert.equal(await cmdInit(['--check', '--root', '/repo'], io), 1);
    assert.match(io.stderrText() + io.stdoutText(), /drift|would write/i);
  });
});
