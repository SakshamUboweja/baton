import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { parseFlagsStrict, PLATFORMS } from '../../core/src/commands/shared.mjs';
import { cmdCheckpoint } from '../../core/src/commands/checkpoint.mjs';
import { cmdDoctor } from '../../core/src/commands/doctor.mjs';
import { cmdRemap } from '../../core/src/commands/remap.mjs';

// ---------------------------------------------------------------------------
// Surface-audit fold: the lenient hand-rolled parser silently ate stray tokens
// (a boolean flag's "value") and unknown flags, flipping SAFETY-RELEVANT flags
// off with exit 0 — checkpoint --strict, doctor --strict, remap --native-only,
// receive --print-prompt all fail-dangerous. docs/design/core.md §tooling
// already promised strict parsing. parseFlagsStrict(args, spec) enforces it:
// unknown flag, stray positional, or a missing string-flag value each return
// {error} for a usage-error exit 2. --platform/--to values are validated
// against the platform enum (a typo'd platform used to seed persistent bogus
// state that rejected the real platform's checkpoints as foreign).
// ---------------------------------------------------------------------------

describe('parseFlagsStrict', () => {
  const SPEC = { platform: 'string', strict: 'boolean' };

  it('parses known flags: boolean by presence, string by next token', () => {
    const r = parseFlagsStrict(['--platform', 'codex', '--strict'], SPEC);
    assert.equal(r.error, undefined);
    assert.equal(r.flags.platform, 'codex');
    assert.equal(r.flags.strict, true);
  });

  it('a stray token after a boolean flag is a hard error, never a silent flag-loss', () => {
    const r = parseFlagsStrict(['--strict', 'oops'], SPEC);
    assert.ok(r.error && /oops/.test(r.error), `the error names the stray token — got: ${r.error}`);
  });

  it('an unknown flag is a hard error naming it (typos no longer silently lose intent)', () => {
    const r = parseFlagsStrict(['--platfrom', 'codex'], SPEC);
    assert.ok(r.error && /--platfrom/.test(r.error));
  });

  it('a string flag followed by another KNOWN flag is a missing-value error', () => {
    const r = parseFlagsStrict(['--platform', '--strict'], SPEC);
    assert.ok(r.error && /--platform/.test(r.error) && /value/i.test(r.error));
  });

  it('json and root are implied common flags for every command', () => {
    const r = parseFlagsStrict(['--json', '--root', '/x'], {});
    assert.equal(r.error, undefined);
    assert.equal(r.flags.json, true);
    assert.equal(r.flags.root, '/x');
  });

  it('an empty-string value is consumed as a value, not a stray token', () => {
    const r = parseFlagsStrict(['--platform', ''], SPEC);
    assert.equal(r.error, undefined);
    assert.equal(r.flags.platform, '');
  });
});

describe('fail-dangerous flag loss is dead (command level)', () => {
  it('checkpoint --strict with a stray token exits 2, not a silent non-strict 0', async () => {
    const io = makeIo({ stdin: 'not json' });
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--strict', 'stray'], io);
    assert.equal(code, 2, 'usage error, never a soft exit that CI reads as green');
  });

  it('doctor --strict with a stray token exits 2', async () => {
    const io = makeIo();
    const code = await cmdDoctor(['--strict', 'stray'], io);
    assert.equal(code, 2);
  });

  it('remap --native-only with a stray token exits 2, never a silent cross-platform remap', async () => {
    const io = makeIo();
    const code = await cmdRemap(['--to', 'codex', '--native-only', 'stray'], io);
    assert.equal(code, 2);
  });
});

describe('every migrated command rejects garbled invocations (test-verifier finding 2)', () => {
  // Table-driven: each command switched to parseFlagsStrict must exit 2 on a
  // stray positional and on an unknown flag — a single command silently
  // regressing to lenient parsing reds here.
  const CASES = [
    ['detect', () => import('../../core/src/commands/detect.mjs').then((m) => m.cmdDetect), ['--platform', 'codex', '--text', 'x']],
    ['finalize', () => import('../../core/src/commands/finalize.mjs').then((m) => m.cmdFinalize), ['--reason', 'r']],
    ['status', () => import('../../core/src/commands/status.mjs').then((m) => m.cmdStatus), []],
    ['purge-transcript', () => import('../../core/src/commands/purge-transcript.mjs').then((m) => m.cmdPurgeTranscript), []],
    ['recover', () => import('../../core/src/commands/recover.mjs').then((m) => m.cmdRecover), []],
    ['session-start', () => import('../../core/src/commands/session-start.mjs').then((m) => m.cmdSessionStart), ['--platform', 'codex']],
    ['receive', () => import('../../core/src/commands/receive.mjs').then((m) => m.cmdReceive), ['--platform', 'codex']],
    ['init', () => import('../../core/src/commands/init.mjs').then((m) => m.cmdInit), []],
  ];

  for (const [name, load, validArgs] of CASES) {
    it(`${name}: stray positional and unknown flag both exit 2`, async () => {
      const cmd = await load();
      const io1 = makeIo({ stdin: '{}' });
      assert.equal(await cmd([...validArgs, 'stray-token'], io1), 2, `${name}: a stray positional is a usage error`);
      const io2 = makeIo({ stdin: '{}' });
      assert.equal(await cmd([...validArgs, '--no-such-flag'], io2), 2, `${name}: an unknown flag is a usage error`);
    });
  }
});

describe('--platform / --to enum validation', () => {
  it('PLATFORMS is the supported enum', () => {
    assert.deepEqual(PLATFORMS, ['claude-code', 'codex', 'cursor']);
  });

  it('a typo’d checkpoint --platform exits 2 instead of seeding bogus persistent state', async () => {
    const io = makeIo({ stdin: '{}' });
    const code = await cmdCheckpoint(['--platform', 'claud-code'], io);
    assert.equal(code, 2);
    assert.match(io.stderrText(), /claude-code\|codex\|cursor/, 'the error lists the valid platforms');
  });

  it('a typo’d remap --to exits 2', async () => {
    const io = makeIo();
    const code = await cmdRemap(['--to', 'kodex'], io);
    assert.equal(code, 2);
  });
});
