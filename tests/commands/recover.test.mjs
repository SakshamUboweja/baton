import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { cmdRecover } from '../../core/src/commands/recover.mjs';

// ---------------------------------------------------------------------------
// Gate-2 fix 11 (reviewer-a finding 14): `recover` sat in the frozen command
// list returning not-implemented. cmdRecover wraps recoverLock and keeps its
// one hard rule: exactly ONE state recovers — a provably-dead same-host owner.
// `--force` is an intent flag only; live, cross-host, and torn states refuse
// with the same reasons, force or not.
// ---------------------------------------------------------------------------

const OWNER = (over = {}) => JSON.stringify({ host: 'host-A', pid: 999, startTime: 5, fencingToken: 't', acquiredAt: 'x', heartbeatAt: 'x', ...over });

describe('cmdRecover — the one recoverable state', () => {
  it('free lock: exit 0, nothing to do', async () => {
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': '{}' } });
    assert.equal(await cmdRecover([], io), 0);
    assert.match(io.stdoutText(), /recovered|free|nothing/i);
  });

  it('provably-dead same-host owner: cleared, journal note recorded, exit 0', async () => {
    const io = makeIo({ files: { '/repo/.handoff/lock/owner.json': OWNER() } });
    // default processAlive: only THIS io's pid/startTime is alive -> 999 is dead
    assert.equal(await cmdRecover([], io), 0);
    assert.equal(io.fs.existsSync('/repo/.handoff/lock'), false, 'stale lock removed');
    assert.match(io.files()['/repo/.handoff/journal.ndjson'] ?? '', /recovery/i);
  });

  it('live same-host owner: refused with exit 1, EVEN with --force', async () => {
    const files = { '/repo/.handoff/lock/owner.json': OWNER() };
    const alive = () => true;
    const io = makeIo({ files, processAlive: alive });
    assert.equal(await cmdRecover([], io), 1);
    assert.match(io.stderrText(), /live process/i);
    assert.equal(io.fs.existsSync('/repo/.handoff/lock'), true, 'the live owner keeps its lock');

    const io2 = makeIo({ files, processAlive: alive });
    assert.equal(await cmdRecover(['--force'], io2), 1, 'force never overrides a live owner');
    assert.equal(io2.fs.existsSync('/repo/.handoff/lock'), true);
  });

  it('cross-host owner: refused, exit 1', async () => {
    const io = makeIo({ files: { '/repo/.handoff/lock/owner.json': OWNER({ host: 'other-host' }) } });
    assert.equal(await cmdRecover(['--force'], io), 1);
    assert.match(io.stderrText(), /another host/i);
  });

  it('torn metadata (lock dir without owner.json): refused, exit 1', async () => {
    const io = makeIo({ files: {} });
    io.fs.mkdirSync('/repo/.handoff/lock', { recursive: true });
    assert.equal(await cmdRecover([], io), 1);
    assert.match(io.stderrText(), /torn|unsupported/i);
  });

  it('--json emits exactly one envelope for both outcomes', async () => {
    const io = makeIo({ files: { '/repo/.handoff/lock/owner.json': OWNER() } });
    assert.equal(await cmdRecover(['--json'], io), 0);
    const env = JSON.parse(io.stdoutText());
    assert.equal(env.ok, true);
    assert.equal(env.data.recovered, true);

    const io2 = makeIo({ files: { '/repo/.handoff/lock/owner.json': OWNER({ host: 'other' }) } });
    assert.equal(await cmdRecover(['--json'], io2), 1);
    const env2 = JSON.parse(io2.stdoutText());
    assert.equal(env2.ok, false);
    assert.equal(env2.data?.recovered ?? false, false);
  });
});
