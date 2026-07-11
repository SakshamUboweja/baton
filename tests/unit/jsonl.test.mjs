import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeMemfs } from '../helpers/memfs.mjs';
import { appendEntry, readAllTolerant } from '../../core/src/util/jsonl.mjs';
import { newBundleId, dedupeKey } from '../../core/src/util/ids.mjs';

describe('jsonl.appendEntry + readAllTolerant', () => {
  it('roundtrips appended entries in order with no warnings', () => {
    const { fs, files } = makeMemfs();
    fs.mkdirSync('/repo', { recursive: true });
    const path = '/repo/journal.ndjson';
    const entries = [{ seq: 1, type: 'note' }, { seq: 2, type: 'decision' }, { seq: 3, type: 'file.touch' }];

    for (const e of entries) appendEntry(fs, path, e);

    // Each entry is exactly one JSON line terminated by '\n'.
    assert.ok(files()[path].endsWith('\n'));

    const { entries: read, warnings } = readAllTolerant(fs, path);
    assert.deepEqual(read, entries);
    assert.deepEqual(warnings, []);
  });

  it('returns empty entries (no throw) for a missing file', () => {
    const { fs } = makeMemfs();
    let r;
    assert.doesNotThrow(() => { r = readAllTolerant(fs, '/repo/missing.ndjson'); });
    assert.deepEqual(r.entries, []);
    assert.deepEqual(r.warnings, []);
  });

  it('drops a torn (non-newline-terminated) final line with a warning naming its line number', () => {
    // Lines 1-2 are complete; line 3 is a partial write with no trailing '\n'.
    const { fs } = makeMemfs({
      '/repo/journal.ndjson': '{"seq":1}\n{"seq":2}\n{"seq":3', // torn tail
    });

    const { entries, warnings } = readAllTolerant(fs, '/repo/journal.ndjson');

    assert.deepEqual(entries, [{ seq: 1 }, { seq: 2 }]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].line, 3);
    assert.equal(warnings[0].kind, 'torn-tail');
  });

  it('records a mid-file corrupt line as a parse-error but keeps parsing later lines', () => {
    const { fs } = makeMemfs({
      '/repo/journal.ndjson': '{"seq":1}\nNOT JSON HERE\n{"seq":3}\n',
    });

    const { entries, warnings } = readAllTolerant(fs, '/repo/journal.ndjson');

    assert.deepEqual(entries, [{ seq: 1 }, { seq: 3 }]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].line, 2);
    assert.equal(warnings[0].kind, 'parse-error');
  });

  it('warns (seq-order) when a parsed seq decreases, but still includes the entry', () => {
    // Journal seq must be monotonically increasing. A decrease signals reordering
    // or corruption: warn, but keep the entry so replay/audit still sees it.
    const { fs } = makeMemfs({
      '/repo/journal.ndjson': '{"seq":1}\n{"seq":5}\n{"seq":3}\n',
    });

    const { entries, warnings } = readAllTolerant(fs, '/repo/journal.ndjson');

    assert.deepEqual(entries, [{ seq: 1 }, { seq: 5 }, { seq: 3 }]);
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0], { line: 3, kind: 'seq-order', prev: 5, seq: 3 });
  });

  it('warns (seq-order) on a duplicate seq (equal is not strictly increasing)', () => {
    const { fs } = makeMemfs({
      '/repo/journal.ndjson': '{"seq":1}\n{"seq":2}\n{"seq":2}\n',
    });

    const { entries, warnings } = readAllTolerant(fs, '/repo/journal.ndjson');

    assert.deepEqual(entries, [{ seq: 1 }, { seq: 2 }, { seq: 2 }]);
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0], { line: 3, kind: 'seq-order', prev: 2, seq: 2 });
  });

  it('exempts entries lacking a numeric seq from the seq-order check', () => {
    // A seq-less entry sits between two ascending seqs. It must not be treated as
    // seq 0 / NaN and flagged, and it must not spuriously trip the check on the
    // following entry. Nothing here is out of order, so there are zero warnings.
    const { fs } = makeMemfs({
      '/repo/journal.ndjson': '{"seq":5,"type":"a"}\n{"type":"note"}\n{"seq":6,"type":"b"}\n',
    });

    const { entries, warnings } = readAllTolerant(fs, '/repo/journal.ndjson');

    assert.deepEqual(entries, [
      { seq: 5, type: 'a' },
      { type: 'note' },
      { seq: 6, type: 'b' },
    ]);
    assert.deepEqual(warnings, []);
  });
});

describe('ids.newBundleId', () => {
  it('prefixes with b_ and is deterministic given an injected rand', () => {
    const id1 = newBundleId(() => 0.5);
    const id2 = newBundleId(() => 0.5);
    assert.match(id1, /^b_[0-9a-z]+$/i);
    assert.equal(id1, id2);
  });

  it('yields different ids for different rand values', () => {
    assert.notEqual(newBundleId(() => 0.1), newBundleId(() => 0.9));
  });
});

describe('ids.dedupeKey', () => {
  it('produces a 64-char sha256 hex string', () => {
    assert.match(dedupeKey({ a: 1 }), /^[0-9a-f]{64}$/);
  });

  it('is stable across top-level key order', () => {
    assert.equal(dedupeKey({ a: 1, b: 2 }), dedupeKey({ b: 2, a: 1 }));
  });

  it('is stable across nested key order', () => {
    assert.equal(dedupeKey({ x: { a: 1, b: 2 }, y: 3 }), dedupeKey({ y: 3, x: { b: 2, a: 1 } }));
  });

  it('changes when a value changes', () => {
    assert.notEqual(dedupeKey({ a: 1, b: 2 }), dedupeKey({ a: 1, b: 3 }));
  });

  it('is array-order-sensitive', () => {
    assert.notEqual(dedupeKey({ v: [1, 2] }), dedupeKey({ v: [2, 1] }));
  });

  it('is sha256 over canonical (every-object-keys-sorted) JSON — known vector', () => {
    // Canonical form sorts the keys of every object ascending:
    //   { x: { a: 1, b: 2 }, y: 3 }  ->  '{"x":{"a":1,"b":2},"y":3}'
    // The expected digest below was computed ONCE with node:crypto over that exact
    // canonical string and hardcoded here, so the assertion does not run through the
    // implementation's own hashing code path:
    //   node -e 'console.log(require("crypto").createHash("sha256")
    //     .update(`{"x":{"a":1,"b":2},"y":3}`).digest("hex"))'
    const expected = 'c175735b643d26f24091f96aecccc5024fec04df661f1804b84fd5bf1ea69a0d';

    assert.equal(dedupeKey({ x: { a: 1, b: 2 }, y: 3 }), expected);
    // Reordered keys (nested included) must canonicalize to the same string, so the
    // digest is identical — proving it is SHA-256 over canonical JSON, not some
    // other deterministic hash of the raw serialization.
    assert.equal(dedupeKey({ y: 3, x: { b: 2, a: 1 } }), expected);
  });
});
