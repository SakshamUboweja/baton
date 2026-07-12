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
  it('takeover renames the stale lock dir ASIDE then claims a fresh one (never in-place rm)', () => {
    // Only pid 4242 (this io) is alive → pid 999 is provably dead. The reclaim
    // must be arbitrated by an atomic rename of the SOURCE lock dir, not an
    // rm-then-mkdir that two contenders could both perform (iter-3 finding-1).
    // We trace lock-dir ops in order: the CLAIM must be rename→(rm aside)→mkdir,
    // with no in-place rm of the live /lock before the fresh mkdir. (The final
    // rm of /lock at release, AFTER the mkdir, is correct and expected.)
    const io = makeIo({ files: { [OWNER]: deadOwner } });
    const LOCK = '/repo/.handoff/lock';
    /** @type {string[]} */
    const trace = [];
    const realRename = io.fs.renameSync.bind(io.fs);
    const realRm = io.fs.rmSync.bind(io.fs);
    const realMkdir = io.fs.mkdirSync.bind(io.fs);
    io.fs.renameSync = (from, to) => {
      if (String(from) === LOCK) trace.push(`rename:${/\/lock\.reclaim-/.test(String(to)) ? 'aside' : 'other'}`);
      return realRename(from, to);
    };
    io.fs.rmSync = (p, opts) => {
      if (String(p) === LOCK) trace.push('rm:lock');
      else if (/\/lock\.reclaim-/.test(String(p))) trace.push('rm:aside');
      return realRm(p, opts);
    };
    io.fs.mkdirSync = (p, opts) => {
      if (String(p) === LOCK && !(opts && opts.recursive)) trace.push('mkdir:lock');
      return realMkdir(p, opts);
    };
    const token = withLock('/repo', io, (t) => t);

    // Trace shape: mkdir:lock (initial EEXIST probe) → rename:aside → rm:aside →
    // mkdir:lock (the winning claim) → rm:lock (release, AFTER the claim).
    const claimMkdir = trace.lastIndexOf('mkdir:lock');
    const renameAt = trace.indexOf('rename:aside');
    const rmAsideAt = trace.indexOf('rm:aside');
    assert.ok(renameAt >= 0, `the stale lock dir is moved aside by an atomic rename; trace ${JSON.stringify(trace)}`);
    assert.ok(renameAt < rmAsideAt && rmAsideAt < claimMkdir, 'the claim order is rename-aside → rm-aside → fresh mkdir');
    const beforeClaim = trace.slice(0, claimMkdir);
    assert.equal(beforeClaim.includes('rm:lock'), false, 'the live lock dir is never rm-ed in place during the claim (only renamed aside)');
    assert.ok(typeof token === 'string' && token.length > 0, 'a fresh token is published after the atomic claim');
  });

  it('a contender that loses the rename sees ENOENT-as-contention, not a second takeover', () => {
    // Simulate the rename losing the race: the stale dir is already gone when we
    // try to move it aside → LockHeldError (retryable), never a duplicate claim.
    const io = makeIo({ files: { [OWNER]: deadOwner }, lockRetry: { attempts: 0, delayMs: 0 } });
    const realRename = io.fs.renameSync.bind(io.fs);
    io.fs.renameSync = (from, to) => {
      if (String(from).endsWith('/lock') && /\/lock\.reclaim-/.test(String(to))) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return realRename(from, to);
    };
    assert.throws(() => withLock('/repo', io, (t) => t), /reclaiming the dead lock|transient contention/i);
  });

  it('the takeover note is journaled while the lock dir is HELD — seq allocated under the lock (iter-3 F2)', () => {
    // Deterministic white-box guard for the under-lock-collision finding: the
    // old code journaled the takeover during arbitration (dir renamed aside, NOT
    // held), so its seq could collide with a free-path competitor's concurrent
    // append. Assert the note is appended only while the canonical lock dir
    // exists (held). Fails against journal-before-lock, which appends it while
    // the dir is renamed away.
    const io = makeIo({ files: { [OWNER]: deadOwner, '/repo/.handoff/bundle.json': '{"journalSeq":0}' } });
    const LOCK = '/repo/.handoff/lock';
    let heldAtNoteTime = null;
    const realAppend = io.fs.appendFileSync.bind(io.fs);
    io.fs.appendFileSync = (p, data) => {
      if (String(p).endsWith('/journal.ndjson') && /took over stale lock/.test(String(data))) {
        heldAtNoteTime = io.fs.existsSync(LOCK);
      }
      return realAppend(p, data);
    };
    withLock('/repo', io, (t) => t);
    assert.equal(heldAtNoteTime, true, 'the takeover note is appended while the lock dir is held');
  });

  it('recoverLock reclaims atomically and journals under the HELD lock (iter-3 F2 / iter-4 I1)', () => {
    // recoverLock now reuses the atomic acquire (rename-arbitrated dead-reclaim)
    // rather than a bare rmSync, so its audit note is the takeover note acquire
    // writes AFTER publishOwner — under the held lock (seq allocated safely).
    const io = makeIo({ files: { [OWNER]: deadOwner, '/repo/.handoff/bundle.json': '{"journalSeq":0}' } });
    const LOCK = '/repo/.handoff/lock';
    let heldAtNoteTime = null;
    const realAppend = io.fs.appendFileSync.bind(io.fs);
    io.fs.appendFileSync = (p, data) => {
      if (String(p).endsWith('/journal.ndjson') && /took over stale lock|lock recovery/.test(String(data))) {
        heldAtNoteTime = io.fs.existsSync(LOCK);
      }
      return realAppend(p, data);
    };
    const r = recoverLock('/repo', io, { force: true });
    assert.equal(r.recovered, true, 'a provably-dead lock is recovered');
    assert.equal(heldAtNoteTime, true, 'the recovery/takeover note is appended while the lock dir is held, never after a bare rmSync');
    assert.equal(io.fs.existsSync(LOCK), false, 'the lock is released after recovery');
  });

  it('recoverLock refuses (no steal) when a competitor reclaims the dead lock between inspect and acquire (iter-4 I1)', () => {
    // TOCTOU guard: recoverLock's outer inspect sees the DEAD owner, but by the
    // time acquire() re-inspects, a competitor has published a LIVE owner. The
    // old inspect-then-rmSync would delete that live lock; the acquire-based
    // path re-inspects atomically, sees live, and refuses. We flip owner.json to
    // a live pid on acquire's inspect (the SECOND read of owner.json — the first
    // is recoverLock's own outer inspect).
    // pid 4242 is alive, 999 (the seeded dead owner) is not — so the outer
    // inspect sees dead and acquire's re-inspect sees the injected live owner.
    const io = makeIo({ files: { [OWNER]: deadOwner, '/repo/.handoff/bundle.json': '{"journalSeq":0}' }, processAlive: (pid) => pid === 4242 });
    const LIVE = JSON.stringify({ host: 'host-A', pid: 4242, startTime: 1, fencingToken: 'LIVE', acquiredAt: 'x', heartbeatAt: 'x' });
    let ownerReads = 0;
    const realRead = io.fs.readFileSync.bind(io.fs);
    io.fs.readFileSync = (p, enc) => {
      if (String(p).endsWith('/lock/owner.json')) {
        ownerReads += 1;
        if (ownerReads >= 2) return LIVE; // acquire's re-inspection sees a live owner
      }
      return realRead(p, enc);
    };
    const r = recoverLock('/repo', io, { force: true });
    assert.equal(r.recovered, false, 'a lock that became live during recovery is not stolen');
    assert.match(r.refusedReason, /live process|held/i);
    assert.equal(io.fs.existsSync('/repo/.handoff/lock'), true, 'the live lock is left intact');
  });

  it('a takeover journalNote failure does NOT abort acquisition or leak the lock (iter-4 I7)', () => {
    // journalNote runs after publishOwner but before the token returns to
    // withLock. Without the try/catch, a throw there escapes acquire() → the
    // release finally never runs → the lock leaks with a live owner. Make the
    // note append THROW and assert acquisition still completes and releases.
    const io = makeIo({ files: { [OWNER]: deadOwner, '/repo/.handoff/bundle.json': '{"journalSeq":0}' } });
    const realAppend = io.fs.appendFileSync.bind(io.fs);
    io.fs.appendFileSync = (p, data) => {
      if (String(p).endsWith('/journal.ndjson') && /took over stale lock/.test(String(data))) {
        throw new Error('simulated disk-full on the audit note');
      }
      return realAppend(p, data);
    };
    let token;
    assert.doesNotThrow(() => {
      token = withLock('/repo', io, (t) => t);
    }, 'a note-write failure must not abort the reclaim');
    assert.ok(token, 'the token is returned despite the note failure');
    assert.equal(io.fs.existsSync('/repo/.handoff/lock'), false, 'the lock is released (no leak)');
  });

  it('after release the lock is free and the next acquisition mints its own token', () => {
    const io = makeIo({ files: { [OWNER]: deadOwner } });
    const first = withLock('/repo', io, (t) => t);
    assert.ok(first, 'first contender takes over the dead lock');
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
