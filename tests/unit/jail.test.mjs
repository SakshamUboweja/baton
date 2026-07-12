import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { jailRelPath, checkHandoffTree } from '../../core/src/util/jail.mjs';

// ---------------------------------------------------------------------------
// Gate-2 fix 6 (reviewer-a findings 6+8): untrusted paths are jailed to the
// repository root and the managed .handoff tree refuses symlinks. jailRelPath
// is the single pure gate every bundle-borne path passes through; symlink
// refusal over the REAL fs lives in tests/integration/symlink-escape.test.mjs
// (this fake cannot represent links).
// ---------------------------------------------------------------------------

const NUL = String.fromCharCode(0);

describe('jailRelPath — repo-relative path jail', () => {
  it('accepts and normalizes ordinary relative paths', () => {
    assert.equal(jailRelPath('src/a.js'), 'src/a.js');
    assert.equal(jailRelPath('a'), 'a');
    assert.equal(jailRelPath('./src//a.js'), 'src/a.js');
    assert.equal(jailRelPath('a/b/../c'), 'a/c');
    assert.equal(jailRelPath('deep/x/./y.txt'), 'deep/x/y.txt');
  });

  it('normalizes backslashes as separators before jailing', () => {
    assert.equal(jailRelPath('src\\win\\a.js'), 'src/win/a.js');
  });

  it('refuses absolute paths (posix, windows drive, UNC)', () => {
    assert.equal(jailRelPath('/etc/passwd'), null);
    assert.equal(jailRelPath('C:\\secrets\\k.json'), null);
    assert.equal(jailRelPath('c:/secrets/k.json'), null);
    assert.equal(jailRelPath('\\\\server\\share\\f'), null);
  });

  it('refuses escaping traversals, including post-normalization escapes', () => {
    assert.equal(jailRelPath('../x'), null);
    assert.equal(jailRelPath('a/../../x'), null);
    assert.equal(jailRelPath('a\\..\\..\\x'), null);
  });

  it('refuses non-strings, empties, dot-only, and NUL bytes', () => {
    assert.equal(jailRelPath(null), null);
    assert.equal(jailRelPath(undefined), null);
    assert.equal(jailRelPath(42), null);
    assert.equal(jailRelPath(''), null);
    assert.equal(jailRelPath('.'), null);
    assert.equal(jailRelPath('..'), null);
    assert.equal(jailRelPath(`a${NUL}b`), null);
  });
});

describe('checkHandoffTree — managed-tree guard (fake fs happy paths)', () => {
  it('ok when no .handoff exists', () => {
    const io = makeIo({ files: { '/repo/x.txt': 'x' } });
    assert.equal(checkHandoffTree('/repo', io).ok, true);
  });

  it('ok on a plain tree with nested history and log dirs', () => {
    const io = makeIo({
      files: {
        '/repo/.handoff/bundle.json': '{}',
        '/repo/.handoff/journal.ndjson': '',
        '/repo/.handoff/history/2026.finalize.json': '{}',
        '/repo/.handoff/log/probe-cache.json': '{}',
      },
    });
    assert.equal(checkHandoffTree('/repo', io).ok, true);
  });

  it('refuses when the tree cannot be verified (lstat throwing)', () => {
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': '{}' } });
    io.fs.lstatSync = () => {
      throw new Error('EIO: probe failed');
    };
    const r = checkHandoffTree('/repo', io);
    assert.equal(r.ok, false);
    assert.match(r.problem, /verif/i);
  });

  it('refuses when an entry reports as a symlink', () => {
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': '{}', '/repo/.handoff/evil.json': '{}' } });
    const realLstat = io.fs.lstatSync.bind(io.fs);
    io.fs.lstatSync = (p) => {
      const st = realLstat(p);
      if (String(p).endsWith('evil.json')) return { ...st, isSymbolicLink: () => true };
      return st;
    };
    const r = checkHandoffTree('/repo', io);
    assert.equal(r.ok, false);
    assert.match(r.problem, /symlink/i);
    assert.match(r.problem, /evil\.json/);
  });

  it('refuses when .handoff realpath escapes the root', () => {
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': '{}' } });
    const realReal = io.fs.realpathSync.bind(io.fs);
    io.fs.realpathSync = (p) => (String(p) === '/repo/.handoff' ? '/elsewhere/.handoff' : realReal(p));
    const r = checkHandoffTree('/repo', io);
    assert.equal(r.ok, false);
    assert.match(r.problem, /outside/i);
  });
});
