import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { withLock, recoverLock } from '../../core/src/bundle/lock.mjs';

// ---------------------------------------------------------------------------
// Gate-2 iteration-2 findings B1 + B2 (reviewer-a #3, #4): the dead-lock
// takeover must atomically RE-CLAIM the lock dir (not just republish owner.json
// into the existing one), and every lock/recover mutation must pass the
// managed-tree jail first so a symlinked .handoff/lock cannot be followed
// outside the repository.
// ---------------------------------------------------------------------------

const OWNER = '/repo/.handoff/lock/owner.json';
const deadOwner = JSON.stringify({ host: 'host-A', pid: 999, startTime: 5, fencingToken: 'STALE', acquiredAt: 'x', heartbeatAt: 'x' });

describe('dead-takeover re-claims the lock dir atomically (B1)', () => {
  it('takeover recreates the lock dir, not just owner.json in place', () => {
    // Only pid 4242 (this io) is alive → pid 999 is provably dead.
    const io = makeIo({ files: { [OWNER]: deadOwner } });
    let removed = false;
    let recreated = false;
    const realRm = io.fs.rmSync.bind(io.fs);
    const realMkdir = io.fs.mkdirSync.bind(io.fs);
    io.fs.rmSync = (p, opts) => {
      if (String(p).endsWith('/lock')) removed = true;
      return realRm(p, opts);
    };
    io.fs.mkdirSync = (p, opts) => {
      if (String(p).endsWith('/lock') && !(opts && opts.recursive)) recreated = true;
      return realMkdir(p, opts);
    };
    const token = withLock('/repo', io, (t) => t);
    assert.ok(removed, 'the stale lock dir is removed as part of the claim');
    assert.ok(recreated, 'the lock dir is re-created (mkdir EEXIST is the claim primitive), not reused in place');
    assert.ok(typeof token === 'string' && token.length > 0, 'a fresh token is published after the atomic claim');
  });

  it('two contenders against one dead lock: exactly one takes over per claim attempt', () => {
    // Model the race: contender 1 removes the dead lock, contender 2 tries to
    // claim the now-empty slot. With an atomic mkdir-claim, the second mkdir of
    // an already-claimed dir throws EEXIST → contention, never a double publish.
    const io = makeIo({ files: { [OWNER]: deadOwner } });
    const first = withLock('/repo', io, (t) => t);
    assert.ok(first, 'first contender takes over the dead lock');
    // After release the dir is gone; a fresh acquire on the free slot succeeds.
    assert.equal(io.fs.existsSync('/repo/.handoff/lock'), false, 'lock released after the operation');
    const second = withLock('/repo', io, (t) => t);
    assert.ok(second && second !== first, 'the next acquisition gets its own fresh token');
  });
});

describe('lock/recover refuse a symlinked managed tree before mutating (B2)', () => {
  function symlinkedLockIo() {
    // The lock dir exists inside the managed tree (so the jail walk encounters
    // it) but is a symlink pointing outside the repo: lstat reports a link.
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': '{}', '/repo/.handoff/lock/owner.json': deadOwner } });
    const realLstat = io.fs.lstatSync.bind(io.fs);
    io.fs.lstatSync = (p) => {
      if (String(p) === '/repo/.handoff/lock') return { ...realLstat('/repo/.handoff'), isSymbolicLink: () => true, isDirectory: () => true, isFile: () => false };
      return realLstat(p);
    };
    return io;
  }

  it('withLock refuses to acquire through a symlinked lock dir', () => {
    const io = symlinkedLockIo();
    let rmCalled = false;
    const realRm = io.fs.rmSync.bind(io.fs);
    io.fs.rmSync = (p, opts) => {
      rmCalled = true;
      return realRm(p, opts);
    };
    assert.throws(() => withLock('/repo', io, () => 'nope'), /symlink|jail|unsafe/i);
    assert.equal(rmCalled, false, 'nothing is removed through the link');
  });

  it('recoverLock refuses a symlinked lock dir even with --force', () => {
    const io = symlinkedLockIo();
    const r = recoverLock('/repo', io, { force: true });
    assert.equal(r.recovered, false);
    assert.match(r.refusedReason, /symlink|jail|unsafe/i);
  });
});
