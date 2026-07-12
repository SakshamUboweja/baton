import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { normSep, joinNorm, isContained } from '../../core/src/util/pathnorm.mjs';
import { checkHandoffTree } from '../../core/src/util/jail.mjs';
import { resolveRoot } from '../../core/src/commands/shared.mjs';

// ---------------------------------------------------------------------------
// Gate-2 iteration-3 F6 + F9 (reviewer-a #5/#10, reviewer-b #6): the Windows
// path class. realpathSync returns backslash paths; every containment/ascent
// check must compare in one normalized forward-slash space, and a drive-root
// repo (C:/) must not produce a doubled-slash C://.handoff that never matches.
// ---------------------------------------------------------------------------

describe('normSep / joinNorm / isContained', () => {
  it('normSep canonicalizes backslashes, doubled and trailing separators', () => {
    assert.equal(normSep('C:\\repo\\.handoff'), 'C:/repo/.handoff');
    assert.equal(normSep('C://repo//.handoff'), 'C:/repo/.handoff');
    assert.equal(normSep('/repo/'), '/repo');
    assert.equal(normSep('/'), '/');
  });

  it('joinNorm never doubles the separator at a drive root', () => {
    assert.equal(joinNorm('C:/', '.handoff'), 'C:/.handoff');
    assert.equal(joinNorm('/repo', '.handoff'), '/repo/.handoff');
  });

  it('isContained is volume-aware and prefix-safe', () => {
    assert.equal(isContained('C:\\repo', 'C:/repo/.handoff'), true);
    assert.equal(isContained('C:/repo', 'C:/repository'), false); // not a path-segment prefix
    assert.equal(isContained('C:/', 'C:/.handoff'), true);
    assert.equal(isContained('/repo', '/repo'), true);
    assert.equal(isContained('/repo', '/other/.handoff'), false);
  });

  it('isContained handles a POSIX-root base (iter-4 I8)', () => {
    // A repo rooted at '/' must contain everything under it — the old '//'
    // prefix rejected every child.
    assert.equal(isContained('/', '/transcript.jsonl'), true);
    assert.equal(isContained('/', '/'), true);
    assert.equal(isContained('/', 'relative'), false);
  });
});

describe('checkHandoffTree containment on Windows realpaths (F6)', () => {
  const DIR = 'C:/repo/.handoff';
  const winIo = (rootReal, dirReal) => ({
    fs: {
      existsSync: (/** @type {any} */ p) => String(p) === DIR,
      lstatSync: (/** @type {any} */ p) => ({
        isSymbolicLink: () => false,
        isDirectory: () => String(p) === DIR,
        isFile: () => String(p) !== DIR,
      }),
      realpathSync: (/** @type {any} */ p) => {
        const s = String(p);
        if (s === 'C:/repo') return rootReal;
        if (s === DIR) return dirReal;
        return s;
      },
      readdirSync: () => [],
    },
  });

  it('accepts a backslash-spelled in-tree .handoff', () => {
    assert.deepEqual(checkHandoffTree('C:/repo', winIo('C:\\repo', 'C:\\repo\\.handoff')), { ok: true });
  });

  it('accepts a DRIVE-ROOT repo (C:/) without a doubled-slash mismatch', () => {
    const io = {
      fs: {
        existsSync: (/** @type {any} */ p) => String(p) === 'C:/.handoff',
        lstatSync: (/** @type {any} */ p) => ({ isSymbolicLink: () => false, isDirectory: () => String(p) === 'C:/.handoff', isFile: () => false }),
        realpathSync: (/** @type {any} */ p) => (String(p) === 'C:/' ? 'C:\\' : String(p) === 'C:/.handoff' ? 'C:\\.handoff' : String(p)),
        readdirSync: () => [],
      },
    };
    assert.deepEqual(checkHandoffTree('C:/', io), { ok: true });
  });

  it('still refuses an escaped/cross-volume realpath', () => {
    const r = checkHandoffTree('C:/repo', winIo('C:\\repo', 'D:\\repo\\.handoff'));
    assert.equal(r.ok, false);
    assert.match(r.problem, /outside the repository root/i);
  });
});

describe('resolveRoot ascent examines the drive root (F6)', () => {
  it('finds a marker at a drive-root repo C:/', () => {
    // baton.config.json is a FILE (the memfs fake resolves store files by their
    // normalized key; directory existence has a leading-slash quirk irrelevant
    // to the code path under test — the drive-root ascent).
    const io = makeIo({ files: { 'C:/baton.config.json': '{}', 'C:/sub/deep/x.txt': 'x' } });
    io.cwd = 'C:\\sub\\deep';
    assert.equal(resolveRoot(io, {}), 'C:/');
  });

  it('still resolves a nested drive-path repo', () => {
    const io = makeIo({ files: { 'C:/repo/baton.config.json': '{}', 'C:/repo/sub/x.txt': 'x' } });
    io.cwd = 'C:\\repo\\sub';
    assert.equal(resolveRoot(io, {}), 'C:/repo');
  });
});
