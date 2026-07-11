import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { withLock, recoverLock, guardedWrite } from '../../core/src/bundle/lock.mjs';
import { readAllTolerant } from '../../core/src/util/jsonl.mjs';

// ---------------------------------------------------------------------------
// Contract choices for bundle/lock.mjs (plan §Concurrency "Lock model"
// iterations 3+4, §"Journal rotation & crash recovery"; docs/design/core.md
// §Module APIs + §lock test list). Readings pinned where the spec left room:
//
//   1. OPERATION-SCOPED & SYNCHRONOUS — withLock acquires, runs fn synchronously,
//      then releases; it returns fn's return value. Everything the lock guards
//      in this codebase is synchronous fs work (fsx/jsonl are all sync), so the
//      lock primitive is sync too. guardedWrite and recoverLock are likewise
//      synchronous.
//   2. ACQUIRE = atomic `mkdir` of `<root>/.handoff/lock/` (memfs's non-recursive
//      mkdirSync throws EEXIST on an existing dir — the exclusivity primitive).
//      On success, owner.json {host, pid, startTime, fencingToken, acquiredAt,
//      heartbeatAt} is written atomically and the fencingToken is exposed to fn.
//      RELEASE = rm the lock dir (even if fn throws).
//   3. FENCING TOKEN comes from io.newFencingToken() (injected, deterministic in
//      tests). A takeover issues a FRESH token.
//   4. CONTENTION RULES (conservative on every OS):
//        - LIVE same-host owner (io.processAlive(pid,startTime) truthy, owner.host
//          === io.host) → REFUSE, throw LockHeldError; NEVER steal. Its .message
//          names the owner (host + pid) and says to terminate that process.
//        - Provably-dead same-host owner (processAlive falsy, same host) →
//          TAKE OVER: republish owner.json (our identity + a fresh token) and
//          append a journal note recording the takeover.
//        - Cross-host owner (owner.host !== io.host) → REFUSE even if it looks
//          dead (no cross-host auto-recovery).
//        - Torn metadata (lock dir present but owner.json absent or unparseable)
//          → REFUSE, and leave the lock dir untouched (no auto-recovery).
//   5. guardedWrite(root, io, token, fn) re-reads owner.json and throws
//      FencingError when the CURRENT fencingToken !== token; otherwise runs fn
//      and returns its result. This is the fast-abort layer for a holder that
//      paused past its last check while another process took over.
//   6. recoverLock(root, io, {force}) -> {recovered, refusedReason}. The lock
//      model is SYMMETRIC in `force`: force changes NOTHING about the recovery
//      decision (iteration-4 rule — it is retained on the CLI as an explicit-
//      intent flag only). Recovery succeeds for exactly ONE state: a provably-
//      dead SAME-HOST owner (recovered:true, refusedReason:null, lock cleared +
//      a journal note) — with force or without. EVERY other state is REFUSED
//      (recovered:false) and the lock dir is left byte-for-byte intact:
//        - LIVE same-host owner → refusedReason names it (host + pid) and says to
//          terminate that process first; it must NOT tell the human to delete the
//          lock (deleting a live owner's lock is the unsafe path).
//        - cross-host owner, torn (unparseable) owner.json, or MISSING owner.json
//          under a present lock dir → "unsupported for automatic recovery":
//          refusedReason names the cause, tells the human to verify no such
//          process is running, and points at deleting `.handoff/lock/` manually
//          as the escape hatch. Even force:true never auto-clears these — a
//          cross-host / torn / missing lock is never provably safe to steal.
//
//   ERROR CONTRACT: refusals surface as thrown Errors. Live-owner refusal uses
//   err.name === 'LockHeldError'; fencing abort uses err.name === 'FencingError';
//   torn/cross-host refusals are asserted by an explanatory message (no name
//   pinned). Paths are hardcoded here so a red failure is attributable to
//   lock.mjs alone, not to store.mjs.
// ---------------------------------------------------------------------------

const T0 = '2026-07-11T00:00:00.000Z';
const LOCK_DIR = '/repo/.handoff/lock';
const OWNER = '/repo/.handoff/lock/owner.json';
const JOURNAL = '/repo/.handoff/journal.ndjson';

const ownerObj = (o) => ({ host: 'host-A', pid: 777, startTime: 42, fencingToken: 'T', acquiredAt: T0, heartbeatAt: T0, ...o });

describe('lock.withLock — acquire / run / release', () => {
  it('acquires the lock, exposes a token that matches owner.json, runs fn, then releases', () => {
    const io = makeIo(); // host-A / pid 4242 / startTime 111000
    let seenToken;
    const result = withLock('/repo', io, (token) => {
      assert.ok(io.fs.existsSync(LOCK_DIR), 'the lock dir is held during fn');
      const owner = JSON.parse(io.fs.readFileSync(OWNER, 'utf8'));
      assert.equal(owner.host, 'host-A');
      assert.equal(owner.pid, 4242);
      assert.equal(owner.startTime, 111000);
      assert.equal(typeof token, 'string');
      assert.equal(owner.fencingToken, token, 'the exposed token equals the published token');
      seenToken = token;
      return 'RESULT';
    });
    assert.equal(result, 'RESULT');
    assert.equal(io.fs.existsSync(LOCK_DIR), false, 'the lock is released after fn returns');
    assert.ok(seenToken);
  });

  it('releases the lock even when fn throws', () => {
    const io = makeIo();
    assert.throws(() => withLock('/repo', io, () => { throw new Error('boom'); }), /boom/);
    assert.equal(io.fs.existsSync(LOCK_DIR), false, 'the lock must be released after an fn error');
  });
});

describe('lock.withLock — mutual exclusion and takeover rules', () => {
  it('refuses a lock held by a LIVE same-host owner (LockHeldError naming it) and never steals it', () => {
    const live = ownerObj({ pid: 777, fencingToken: 'LIVE' });
    const io = makeIo({
      files: { [OWNER]: JSON.stringify(live) },
      processAlive: (pid) => pid === 777 || pid === 4242,
    });
    let ran = false;
    assert.throws(
      () => withLock('/repo', io, () => { ran = true; }),
      (e) => e && e.name === 'LockHeldError' && /777/.test(e.message) && /host-A/.test(e.message),
    );
    assert.equal(ran, false, 'fn must not run when a live owner holds the lock');
    assert.deepEqual(JSON.parse(io.fs.readFileSync(OWNER, 'utf8')), live, 'a live-owner lock is never modified');
  });

  it('takes over a provably-dead same-host lock: transfers ownership, issues a fresh token, notes it', () => {
    const dead = ownerObj({ pid: 999, startTime: 5, fencingToken: 'STALE' });
    const io = makeIo({
      files: { [OWNER]: JSON.stringify(dead) },
      processAlive: (pid) => pid === 4242, // pid 999 is gone
    });
    const result = withLock('/repo', io, (token) => {
      const owner = JSON.parse(io.fs.readFileSync(OWNER, 'utf8'));
      assert.equal(owner.pid, 4242, 'ownership transfers to the live process');
      assert.equal(owner.host, 'host-A');
      assert.equal(owner.fencingToken, token);
      assert.notEqual(owner.fencingToken, 'STALE', 'a fresh fencing token is issued on takeover');
      return 'TOOK-OVER';
    });
    assert.equal(result, 'TOOK-OVER');
    assert.equal(io.fs.existsSync(LOCK_DIR), false, 'released after fn');
    const { entries } = readAllTolerant(io.fs, JOURNAL);
    assert.ok(entries.length >= 1, 'takeover appends a journal note');
    assert.ok(entries.some((e) => /took over|takeover/i.test(JSON.stringify(e))), 'the note records the takeover');
  });

  it('refuses a cross-host owner even when it appears dead (no cross-host auto-recovery)', () => {
    const foreign = ownerObj({ host: 'other-host', pid: 5, startTime: 1 });
    const io = makeIo({ files: { [OWNER]: JSON.stringify(foreign) }, processAlive: () => false });
    assert.throws(() => withLock('/repo', io, () => 'nope'), /host/i);
    assert.deepEqual(JSON.parse(io.fs.readFileSync(OWNER, 'utf8')), foreign, 'a cross-host lock is never modified');
  });

  it('refuses when the lock dir exists but owner.json is absent (torn metadata, no auto-recovery)', () => {
    const io = makeIo({ files: { [`${LOCK_DIR}/.keep`]: '' } });
    assert.throws(() => withLock('/repo', io, () => 'nope'), /metadata|owner|torn|unsupported|manual|recover/i);
    assert.ok(io.fs.existsSync(LOCK_DIR), 'a torn lock is left as-is, never auto-cleared');
  });

  it('refuses when owner.json is unparseable (torn metadata)', () => {
    const io = makeIo({ files: { [OWNER]: '{ not valid json' } });
    assert.throws(() => withLock('/repo', io, () => 'nope'), /metadata|owner|torn|unsupported|manual|recover/i);
  });
});

describe('lock.guardedWrite — fencing', () => {
  it('runs while the token is current and throws FencingError once the owner is replaced mid-operation', () => {
    const io = makeIo();
    let guardedRan = 0;
    let secondRan = false;
    withLock('/repo', io, (token) => {
      const owner = JSON.parse(io.fs.readFileSync(OWNER, 'utf8'));
      assert.equal(owner.fencingToken, token);

      // token still current → guarded write proceeds
      const r = guardedWrite('/repo', io, token, () => { guardedRan += 1; return 'ok'; });
      assert.equal(r, 'ok');
      assert.equal(guardedRan, 1);

      // a competing process takes over and republishes owner.json with a new token
      // while THIS holder is paused past its last check.
      io.fs.writeFileSync(OWNER, JSON.stringify({ ...owner, fencingToken: 'STOLEN-BY-OTHER' }));

      // the stale holder resumes; its guarded write must fast-abort.
      assert.throws(
        () => guardedWrite('/repo', io, token, () => { secondRan = true; return 'must-not-run'; }),
        (e) => e && e.name === 'FencingError',
      );
      assert.equal(secondRan, false, 'the guarded fn must not run after fencing fails');
    });
  });
});

describe('lock.recoverLock', () => {
  it('force + a LIVE same-host owner is STILL refused (terminate the process first)', () => {
    const live = ownerObj({ pid: 777, fencingToken: 'L' });
    const io = makeIo({ files: { [OWNER]: JSON.stringify(live) }, processAlive: (pid) => pid === 777 });
    const r = recoverLock('/repo', io, { force: true });
    assert.equal(r.recovered, false);
    assert.ok(r.refusedReason && /alive|live|running|terminate|777/i.test(r.refusedReason), 'refusal must name the live owner and say to terminate it');
    // A live owner's escape hatch is to kill the process, NOT to delete its lock.
    assert.doesNotMatch(r.refusedReason, /delete|remove/i, 'a live-owner refusal must not instruct deleting the lock');
    assert.deepEqual(JSON.parse(io.fs.readFileSync(OWNER, 'utf8')), live, 'the live lock is left byte-for-byte intact');
    assert.ok(io.fs.existsSync(LOCK_DIR), 'the live lock dir is preserved');
  });

  it('force recovers a provably-dead same-host lock and appends a journal note', () => {
    const dead = ownerObj({ pid: 999, startTime: 5, fencingToken: 'D' });
    const io = makeIo({ files: { [OWNER]: JSON.stringify(dead) }, processAlive: () => false });
    const r = recoverLock('/repo', io, { force: true });
    assert.equal(r.recovered, true);
    assert.ok(!r.refusedReason);
    assert.equal(io.fs.existsSync(LOCK_DIR), false, 'the dead lock is cleared');
    assert.ok(readAllTolerant(io.fs, JOURNAL).entries.some((e) => /recover|lock/i.test(JSON.stringify(e))));
  });

  it('recovers a provably-dead same-host lock WITHOUT force too (force is not required for the dead case)', () => {
    const dead = ownerObj({ pid: 999, startTime: 5, fencingToken: 'D' });
    const io = makeIo({ files: { [OWNER]: JSON.stringify(dead) }, processAlive: () => false });
    const r = recoverLock('/repo', io, {}); // no force
    assert.equal(r.recovered, true, 'a provably-dead same-host lock recovers regardless of force');
    assert.ok(!r.refusedReason);
    assert.equal(io.fs.existsSync(LOCK_DIR), false, 'the dead lock is cleared without force');
  });

  it('force does NOT recover a cross-host lock — refused, cause named, escape hatch given, lock preserved', () => {
    const foreign = ownerObj({ host: 'other-host', pid: 5, startTime: 1 });
    const io = makeIo({ files: { [OWNER]: JSON.stringify(foreign) }, processAlive: () => false });
    const r = recoverLock('/repo', io, { force: true });
    assert.equal(r.recovered, false, 'a cross-host lock is never provably safe to steal, even under force');
    assert.ok(r.refusedReason, 'a refusedReason must explain the refusal');
    assert.match(r.refusedReason, /cross-host|other-host|host/i, 'the cause (cross-host) must be named');
    assert.match(r.refusedReason, /\.handoff\/lock/, 'the manual escape hatch names the lock dir path');
    assert.match(r.refusedReason, /delete|remove/i, 'the escape hatch instructs deleting the lock dir');
    assert.match(r.refusedReason, /verif|confirm|ensure|check|manual/i, 'the escape hatch instructs manual verification first');
    assert.deepEqual(JSON.parse(io.fs.readFileSync(OWNER, 'utf8')), foreign, 'the cross-host lock is left byte-for-byte intact');
    assert.ok(io.fs.existsSync(LOCK_DIR), 'the lock dir is preserved');
  });

  it('force does NOT recover torn (unparseable) metadata — refused, cause named, escape hatch given, lock preserved', () => {
    const io = makeIo({ files: { [OWNER]: '{ not json' } });
    const r = recoverLock('/repo', io, { force: true });
    assert.equal(r.recovered, false, 'torn metadata is unsupported for automatic recovery, even under force');
    assert.ok(r.refusedReason);
    assert.match(r.refusedReason, /torn|metadata|owner|unparse|unverif|unsupported/i, 'the cause (torn metadata) must be named');
    assert.match(r.refusedReason, /\.handoff\/lock/, 'the manual escape hatch names the lock dir path');
    assert.match(r.refusedReason, /delete|remove/i, 'the escape hatch instructs deleting the lock dir');
    assert.match(r.refusedReason, /verif|confirm|ensure|check|manual/i, 'the escape hatch instructs manual verification first');
    assert.equal(io.fs.readFileSync(OWNER, 'utf8'), '{ not json', 'the torn owner.json is left byte-for-byte intact');
    assert.ok(io.fs.existsSync(LOCK_DIR), 'the lock dir is preserved');
  });

  it('force does NOT recover a MISSING owner.json under a present lock dir — refused, escape hatch given, lock preserved', () => {
    const io = makeIo({ files: { [`${LOCK_DIR}/.keep`]: '' } });
    const r = recoverLock('/repo', io, { force: true });
    assert.equal(r.recovered, false, 'missing metadata is unsupported for automatic recovery, even under force');
    assert.ok(r.refusedReason);
    assert.match(r.refusedReason, /missing|metadata|owner|torn|unverif|unsupported/i, 'the cause (missing metadata) must be named');
    assert.match(r.refusedReason, /\.handoff\/lock/, 'the manual escape hatch names the lock dir path');
    assert.match(r.refusedReason, /delete|remove/i, 'the escape hatch instructs deleting the lock dir');
    assert.match(r.refusedReason, /verif|confirm|ensure|check|manual/i, 'the escape hatch instructs manual verification first');
    assert.ok(io.fs.existsSync(LOCK_DIR), 'the lock dir is preserved');
  });
});
