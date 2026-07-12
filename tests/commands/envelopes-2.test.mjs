import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { run } from '../../core/src/cli.mjs';
import { cmdReceive } from '../../core/src/commands/receive.mjs';

// ---------------------------------------------------------------------------
// Gate-2 iteration-2 findings M6 (reviewer-a #11) + B5 (reviewer-a #9):
// - M6: global --json intent is honored before dispatch (`baton --json` with no
//   command emits a usage envelope, not raw USAGE text) and
//   `receive --print-prompt --json` emits an envelope, not raw markdown.
// - B5: the receive.md commit step is a fully-resolved
//   `node "${CLAUDE_PLUGIN_ROOT}/core/bin/baton.mjs" receive …`, not a bare
//   `receive`, so it runs outside the baton repo.
// ---------------------------------------------------------------------------

const T0 = '2026-07-12T00:00:00.000Z';

function oneEnvelope(io) {
  const out = io.stdoutText().trim();
  const lines = out === '' ? [] : out.split('\n');
  assert.equal(lines.length, 1, `expected one stdout envelope, got: ${JSON.stringify(io.stdoutText())}`);
  const env = JSON.parse(lines[0]);
  for (const k of ['ok', 'data', 'warnings', 'error']) assert.ok(k in env, `envelope carries ${k}`);
  return env;
}

describe('M6 — global --json is honored before dispatch', () => {
  it('`baton --json` with no command emits a usage envelope, exit 2', async () => {
    const io = makeIo({});
    assert.equal(await run(['--json'], io), 2);
    const env = oneEnvelope(io);
    assert.equal(env.ok, false);
    assert.equal(env.error.code, 'usage');
  });

  it('`baton --version --json` emits a data envelope carrying the version', async () => {
    const io = makeIo({});
    assert.equal(await run(['--version', '--json'], io), 0);
    const env = oneEnvelope(io);
    assert.equal(env.ok, true);
    assert.equal(typeof env.data.version, 'string');
  });

  it('plain `baton` (no --json) still prints human USAGE, exit 2', async () => {
    const io = makeIo({});
    assert.equal(await run([], io), 2);
    assert.match(io.stdoutText(), /usage: baton/);
  });
});

describe('M6 — receive --print-prompt --json emits an envelope', () => {
  const sealed = {
    schema: 'baton/bundle@1',
    bundleId: 'b_pp000000000000',
    generation: 1,
    createdAt: T0,
    updatedAt: T0,
    origin: { platform: 'claude-code', model: 'm', sessionHint: 's', unstable: false },
    task: { goal: 'ship it', constraints: [], acceptance: [] },
    plan: { steps: [] },
    decisions: [],
    files: { touched: [] },
    roles: { assignments: {} },
    git: null,
    handoff: { status: 'sealed', reason: 'limits', reasonClass: 'usage-limit', toPlatformHint: null, finalizedAt: T0, receive_log: [] },
    journalSeq: 0,
    compaction: { droppedDecisions: 0, note: null },
    dedupeRing: [],
  };
  const files = () => ({
    '/repo/baton.config.json': readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'baton.config.json.tpl'), 'utf8'),
    '/repo/.handoff/bundle.json': JSON.stringify(sealed, null, 2) + '\n',
  });

  it('with --json: exactly one envelope, prompt in data, nothing raw on stdout', async () => {
    const io = makeIo({ files: files(), now: T0 });
    assert.equal(await cmdReceive(['--platform', 'codex', '--print-prompt', '--json', '--origin', 'claude-code', '--reason', 'limits'], io), 0);
    const env = oneEnvelope(io);
    assert.equal(env.ok, true);
    assert.equal(typeof env.data.prompt, 'string');
    assert.match(env.data.prompt, /ship it/, 'the resume prompt is carried in the envelope');
  });

  it('without --json: raw prompt on stdout (the adapter fallback path is unchanged)', async () => {
    const io = makeIo({ files: files(), now: T0 });
    assert.equal(await cmdReceive(['--platform', 'codex', '--print-prompt', '--origin', 'claude-code', '--reason', 'limits'], io), 0);
    const out = io.stdoutText();
    assert.doesNotMatch(out.trim().split('\n')[0] ?? '', /^\{"ok"/, 'no envelope — raw markdown for the hook');
    assert.match(out, /ship it/);
  });
});

describe('B5 — receive.md commit step is fully path-resolved', () => {
  it('every baton invocation in receive.md uses ${CLAUDE_PLUGIN_ROOT}/core/bin/baton.mjs', () => {
    const md = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'adapters', 'claude-code', 'commands', 'receive.md'), 'utf8');
    // Each line that runs a baton subcommand must carry the resolved bin path,
    // never a bare `receive …`.
    const runLines = md.split('\n').filter((l) => /\breceive\b.*--(platform|commit|prepare)/.test(l));
    assert.ok(runLines.length >= 2, 'prepare and commit steps are both present');
    for (const l of runLines) {
      assert.match(l, /\$\{CLAUDE_PLUGIN_ROOT\}\/core\/bin\/baton\.mjs/, `command line must be path-resolved: ${l.trim()}`);
    }
    assert.doesNotMatch(md, /run `receive /, 'no bare `receive …` command anywhere');
  });
});
