import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeMemfs } from '../helpers/memfs.mjs';
import {
  atomicWriteJson,
  safeReadJson,
  backupThenWrite,
  cleanupTmp,
  ensureDir,
} from '../../core/src/util/fsx.mjs';

const isTmp = (name) => /\.tmp\./.test(name);

// Wrap a memfs-shaped fs so renameSync throws EPERM for the first `failTimes`
// calls, then delegates to the real renameSync. This models the Windows AV /
// indexer transient-lock pattern that atomicWriteJson must retry through.
// `failTimes = Infinity` makes the failure permanent. All other fs methods pass
// straight through to the underlying memfs.
function wrapEpermRename(fs, failTimes) {
  let renameCalls = 0;
  const wrapped = {};
  for (const key of Object.keys(fs)) {
    wrapped[key] = typeof fs[key] === 'function' ? (...args) => fs[key](...args) : fs[key];
  }
  wrapped.renameSync = (from, to) => {
    renameCalls += 1;
    if (renameCalls <= failTimes) {
      const e = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`);
      e.code = 'EPERM';
      e.syscall = 'rename';
      throw e;
    }
    return fs.renameSync(from, to);
  };
  wrapped.renameCalls = () => renameCalls;
  return wrapped;
}

describe('fsx.atomicWriteJson', () => {
  it('writes pretty 2-space JSON with a trailing newline', () => {
    const { fs, files } = makeMemfs();
    fs.mkdirSync('/repo', { recursive: true });
    const obj = { hello: 'world', n: 1, nested: { a: 1 } };

    atomicWriteJson(fs, '/repo/data.json', obj);

    const expected = JSON.stringify(obj, null, 2) + '\n';
    assert.equal(files()['/repo/data.json'], expected);
  });

  it('makes the target visible only after rename (never partial, first appearance is a rename)', () => {
    const { fs, files } = makeMemfs();
    fs.mkdirSync('/repo', { recursive: true });
    const obj = { hello: 'world', n: 1 };
    const target = '/repo/data.json';

    atomicWriteJson(fs, target, obj);

    const finalContent = JSON.stringify(obj, null, 2) + '\n';
    assert.equal(files()[target], finalContent);

    // A tmp file must have existed at some intermediate state.
    const sawTmp = fs.__history.some((h) => Object.keys(h.files).some(isTmp));
    assert.ok(sawTmp, 'expected a *.tmp.* file in an intermediate state');

    // The target must never be observed with anything but its final content.
    for (const h of fs.__history) {
      if (target in h.files) {
        assert.equal(h.files[target], finalContent, 'target observed with partial content');
      }
    }

    // The target's first appearance must come from a rename, not a direct write.
    const firstAppearance = fs.__history.find((h) => target in h.files);
    assert.ok(firstAppearance, 'target never appeared in history');
    assert.equal(firstAppearance.op, 'renameSync');
  });

  it('replacing an existing target keeps it continuously showing OLD or final NEW content (never absent/partial)', () => {
    // The target ALREADY exists with valid OLD content. A correct atomic write
    // must never unlink or truncate it in place; the live file must switch from
    // OLD straight to NEW via rename. This catches an implementation that would
    // pass the absent-target case above by unlinking/truncating before writing.
    const oldContent = JSON.stringify({ v: 'old', keep: [1, 2] }, null, 2) + '\n';
    const { fs, files } = makeMemfs({ '/repo/data.json': oldContent });
    const target = '/repo/data.json';
    const obj = { v: 'new', keep: [3, 4, 5] };

    atomicWriteJson(fs, target, obj);

    const newContent = JSON.stringify(obj, null, 2) + '\n';
    assert.equal(files()[target], newContent);

    // Every recorded intermediate state shows the target present and holding
    // either the OLD content or the final NEW content — never absent, never any
    // other (partial) value.
    for (const h of fs.__history) {
      assert.ok(target in h.files, `target absent during an intermediate ${h.op} state`);
      assert.ok(
        h.files[target] === oldContent || h.files[target] === newContent,
        `target observed with neither OLD nor NEW content during ${h.op}: ${JSON.stringify(h.files[target])}`,
      );
    }

    // And the swap to NEW must be performed by renameSync (tmp+rename discipline),
    // not by a direct overwrite of the live file.
    const sawTmp = fs.__history.some((h) => Object.keys(h.files).some(isTmp));
    assert.ok(sawTmp, 'expected a *.tmp.* file in an intermediate state');
    const swap = fs.__history.find((h) => h.files[target] === newContent);
    assert.ok(swap, 'target never reached NEW content in history');
    assert.equal(swap.op, 'renameSync', 'target must switch to NEW content via renameSync');
  });
});

describe('fsx.atomicWriteJson EPERM retry (Windows lock pattern)', () => {
  it('retries renameSync through transient EPERM (fails twice, succeeds on the third) and lands final content', () => {
    const { fs, files } = makeMemfs();
    fs.mkdirSync('/repo', { recursive: true });
    const target = '/repo/data.json';
    const obj = { hello: 'world', n: 2, nested: { a: 1 } };

    const flaky = wrapEpermRename(fs, 2); // attempts 1 & 2 throw EPERM, attempt 3 delegates

    atomicWriteJson(flaky, target, obj);

    const expected = JSON.stringify(obj, null, 2) + '\n';
    assert.equal(files()[target], expected);
    assert.equal(flaky.renameCalls(), 3, 'expected exactly 3 rename attempts (2 EPERM + 1 success)');
  });

  it('surfaces a permanent EPERM after exhausting retries', () => {
    const { fs, files } = makeMemfs();
    fs.mkdirSync('/repo', { recursive: true });
    const target = '/repo/data.json';
    const obj = { hello: 'world' };

    const flaky = wrapEpermRename(fs, Infinity); // every rename attempt throws EPERM

    assert.throws(
      () => atomicWriteJson(flaky, target, obj),
      (e) => e && e.code === 'EPERM',
      'a permanent EPERM must surface after retries are exhausted',
    );
    // Retries were actually attempted, and the target was never created.
    assert.ok(flaky.renameCalls() >= 3, `expected at least 3 rename attempts; got ${flaky.renameCalls()}`);
    assert.equal(files()[target], undefined, 'target must not exist when every rename attempt failed');
  });
});

describe('fsx.safeReadJson', () => {
  it('returns ok:true with the parsed value for valid JSON', () => {
    const { fs } = makeMemfs({ '/repo/good.json': JSON.stringify({ a: 1, b: [2, 3] }) });
    const r = safeReadJson(fs, '/repo/good.json');
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { a: 1, b: [2, 3] });
  });

  it('returns ok:false and never throws on malformed JSON', () => {
    const { fs } = makeMemfs({ '/repo/bad.json': 'not json {' });
    let r;
    assert.doesNotThrow(() => { r = safeReadJson(fs, '/repo/bad.json'); });
    assert.equal(r.ok, false);
    assert.ok(r.error, 'expected an error field on failure');
  });

  it('returns ok:false and never throws on a missing file', () => {
    const { fs } = makeMemfs();
    let r;
    assert.doesNotThrow(() => { r = safeReadJson(fs, '/repo/missing.json'); });
    assert.equal(r.ok, false);
  });

  it('ignores a leftover .tmp sibling and reads the real file', () => {
    const { fs } = makeMemfs({
      '/repo/data.json': JSON.stringify({ real: true }),
      '/repo/data.json.tmp.abc': 'garbage-half-written',
    });
    const r = safeReadJson(fs, '/repo/data.json');
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { real: true });
  });
});

describe('fsx.backupThenWrite', () => {
  it('copies previous good content to <path>.bak before writing new content', () => {
    const { fs, files } = makeMemfs({ '/repo/data.json': 'OLD good content' });

    backupThenWrite(fs, '/repo/data.json', 'NEW content');

    assert.equal(files()['/repo/data.json.bak'], 'OLD good content');
    assert.equal(files()['/repo/data.json'], 'NEW content');
  });

  it('writes without a .bak when there is no existing file', () => {
    const { fs, files } = makeMemfs();
    fs.mkdirSync('/repo', { recursive: true });

    backupThenWrite(fs, '/repo/data.json', 'first content');

    assert.equal(files()['/repo/data.json'], 'first content');
    assert.equal(files()['/repo/data.json.bak'], undefined);
  });
});

describe('fsx.cleanupTmp', () => {
  it('removes leftover *.tmp.* files and leaves everything else', () => {
    const { fs, files } = makeMemfs({
      '/repo/good.json': '{}',
      '/repo/data.json.tmp.abc': 'x',
      '/repo/data.json.tmp.def': 'y',
      '/repo/other.txt': 'keep',
    });

    cleanupTmp(fs, '/repo');

    const after = files();
    assert.equal(after['/repo/data.json.tmp.abc'], undefined);
    assert.equal(after['/repo/data.json.tmp.def'], undefined);
    assert.equal(after['/repo/good.json'], '{}');
    assert.equal(after['/repo/other.txt'], 'keep');
  });

  it('leaves a leftover .tmp untouched for safeReadJson but removes it on cleanup', () => {
    const { fs, files } = makeMemfs({
      '/repo/data.json': JSON.stringify({ real: true }),
      '/repo/data.json.tmp.abc': 'garbage',
    });

    assert.equal(safeReadJson(fs, '/repo/data.json').ok, true);
    cleanupTmp(fs, '/repo');

    assert.equal(files()['/repo/data.json.tmp.abc'], undefined);
    assert.equal(safeReadJson(fs, '/repo/data.json').ok, true);
  });
});

describe('fsx.ensureDir', () => {
  it('creates the directory (with parents) and is idempotent', () => {
    const { fs } = makeMemfs();

    ensureDir(fs, '/repo/a/b/c');
    assert.equal(fs.existsSync('/repo/a/b/c'), true);
    assert.equal(fs.statSync('/repo/a/b/c').isDirectory(), true);

    assert.doesNotThrow(() => ensureDir(fs, '/repo/a/b/c'));
    assert.equal(fs.existsSync('/repo/a/b/c'), true);
  });
});
