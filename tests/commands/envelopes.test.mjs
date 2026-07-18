import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { makeIo } from '../helpers/fakeio.mjs';
import { run } from '../../core/src/cli.mjs';
import { cmdCheckpoint } from '../../core/src/commands/checkpoint.mjs';
import { cmdDetect } from '../../core/src/commands/detect.mjs';
import { cmdFinalize } from '../../core/src/commands/finalize.mjs';
import { cmdReceive } from '../../core/src/commands/receive.mjs';
import { cmdRemap } from '../../core/src/commands/remap.mjs';

// ---------------------------------------------------------------------------
// Gate-2 fix 11 (reviewer-b finding 9): the --json contract is "exactly one
// compact envelope {ok,data,warnings,error} on stdout" for EVERY exit path —
// checkpoint emitted none and usage errors bypassed the envelope everywhere.
// ---------------------------------------------------------------------------

/** stdout must be exactly one parseable envelope line. */
function theEnvelope(io) {
  const out = io.stdoutText().trim();
  const lines = out === '' ? [] : out.split('\n');
  assert.equal(lines.length, 1, `expected exactly one stdout line, got: ${JSON.stringify(io.stdoutText())}`);
  const env = JSON.parse(lines[0]);
  for (const k of ['ok', 'data', 'warnings', 'error']) assert.ok(k in env, `envelope carries ${k}`);
  return env;
}

const EVENT = JSON.stringify({ schema: 'baton/event@1', type: 'decision', payload: { summary: 's' } });

describe('checkpoint --json emits the envelope on every path', () => {
  it('success: ok:true with applied-event data', async () => {
    const io = makeIo({ stdin: EVENT });
    assert.equal(await cmdCheckpoint(['--platform', 'claude-code', '--json'], io), 0);
    const env = theEnvelope(io);
    assert.equal(env.ok, true);
    assert.equal(typeof env.data.events, 'number');
  });

  it('usage error (no --platform): envelope with a usage error, exit 2', async () => {
    const io = makeIo({ stdin: EVENT });
    assert.equal(await cmdCheckpoint(['--json'], io), 2);
    const env = theEnvelope(io);
    assert.equal(env.ok, false);
    assert.equal(env.error.code, 'usage');
  });

  it('garbage stdin: envelope ok:false, exit stays 0 (hook-safety)', async () => {
    const io = makeIo({ stdin: 'not json{{' });
    assert.equal(await cmdCheckpoint(['--platform', 'claude-code', '--json'], io), 0);
    const env = theEnvelope(io);
    assert.equal(env.ok, false);
  });
});

describe('usage errors emit envelopes across commands', () => {
  it('detect without --platform', () => {
    const io = makeIo({});
    assert.equal(cmdDetect(['--json'], io), 2);
    assert.equal(theEnvelope(io).error.code, 'usage');
  });

  it('finalize without --reason', async () => {
    const io = makeIo({});
    assert.equal(await cmdFinalize(['--json'], io), 2);
    assert.equal(theEnvelope(io).error.code, 'usage');
  });

  it('receive without --platform', async () => {
    const io = makeIo({});
    assert.equal(await cmdReceive(['--json'], io), 2);
    assert.equal(theEnvelope(io).error.code, 'usage');
  });

  it('remap without --to', () => {
    const io = makeIo({});
    assert.equal(cmdRemap(['--json'], io), 2);
    assert.equal(theEnvelope(io).error.code, 'usage');
  });

  it('cli: unknown command with --json', async () => {
    const io = makeIo({});
    assert.equal(await run(['no-such-cmd', '--json'], io), 2);
    assert.equal(theEnvelope(io).error.code, 'usage');
  });
});

// ---------------------------------------------------------------------------
// RED — detect: the model-unavailable verdict extends the frozen exit set
// (subtask l1-resolver-entries). plan §"Model-level failover": a model rejected
// at spawn is classified model-unavailable. Exit-code contract: 14 (alongside
// 0/10/11/12/13); --json carries class 'model-unavailable'. cmdDetect loads the
// SHIPPED table, so this pins both the new signature AND the exit mapping.
describe('detect — model-unavailable verdict (exit 14 + --json class)', () => {
  const VERIFIED = 'not supported when using Codex with a ChatGPT account';
  // cmdDetect loads the SHIPPED signatures file via io.fs, so these use the real
  // node fs (the same shipped-table convention as signatures/classifier tests).
  const realFsIo = (over = {}) => {
    const io = makeIo(over);
    io.fs = nodeFs;
    return io;
  };

  it('RED: the verified codex rejection string exits 14', () => {
    const io = realFsIo();
    const code = cmdDetect(['--platform', 'codex', '--text', `Error: ${VERIFIED}.`], io);
    assert.equal(code, 14, 'model-unavailable is exit 14 (extends the frozen 10/11/12/13 set)');
  });

  it('RED: with --json the envelope carries class "model-unavailable", still exit 14', () => {
    const io = realFsIo();
    const code = cmdDetect(['--platform', 'codex', '--text', `Error: ${VERIFIED}.`, '--json'], io);
    assert.equal(code, 14);
    const env = theEnvelope(io);
    assert.equal(env.ok, true);
    assert.equal(env.data.class, 'model-unavailable');
  });

  it('GREEN guard: the frozen exit set is unchanged — a real usage limit still exits 10', () => {
    const io = realFsIo();
    const code = cmdDetect(['--platform', 'codex', '--text', "You've hit your usage limit. Please try again at 6:00 PM."], io);
    assert.equal(code, 10, 'usage-limit stays exit 10 (model-unavailable does not disturb it)');
  });
});
