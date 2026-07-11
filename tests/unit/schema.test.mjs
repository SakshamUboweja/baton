import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emptyBundle, validateBundle, migrate } from '../../core/src/bundle/schema.mjs';

// ---------------------------------------------------------------------------
// Contract choices recorded for this module (docs/design/core.md §Bundle schema,
// §Module APIs; plan §Core engine — Bundle). Where the spec left a detail open,
// these are the readings the tests pin:
//   1. validateBundle error `path` values are dotted paths mirroring the field's
//      location in the bundle: top-level fields use their bare name ('schema',
//      'bundleId', 'journalSeq'); nested fields use dot notation
//      ('handoff.status', 'plan.steps'). This matches the {path, msg} shape and
//      the dotted-path convention used elsewhere in the design doc.
//   2. validateBundle ACCUMULATES errors (the API returns an errors ARRAY), so an
//      object with N distinct problems yields >= N pathed errors — it does not
//      stop at the first failure.
//   3. migrate() on a baton/bundle@1 returns a deep-equal bundle (identity of
//      content). We assert deep-equality, NOT reference identity, so an
//      implementation that defensively copies is still conformant.
//   4. migrate() on baton/bundle@2 THROWS (the prompt's chosen branch), and the
//      thrown Error message NAMES the found schema string.
// ---------------------------------------------------------------------------

const NOW = '2026-07-11T00:00:00.000Z';
const INPUT = { platform: 'claude-code', model: 'claude-opus-4-8', goal: 'ship baton' };

// A fresh, structurally-valid bundle for mutation in the validator tests.
const valid = () => emptyBundle({ platform: 'p', model: 'm', goal: 'g' }, NOW);

describe('schema.emptyBundle', () => {
  it('returns a baton/bundle@1 with the exact documented default shape', () => {
    const b = emptyBundle(INPUT, NOW);

    // bundleId is random (b_ prefix); neutralize it so the rest can be pinned.
    assert.equal(typeof b.bundleId, 'string');
    assert.match(b.bundleId, /^b_/);

    const expected = {
      schema: 'baton/bundle@1',
      bundleId: b.bundleId,
      generation: 1,
      createdAt: NOW,
      updatedAt: NOW,
      origin: { platform: 'claude-code', model: 'claude-opus-4-8', sessionHint: null, unstable: false },
      task: { goal: 'ship baton', constraints: [], acceptance: [] },
      plan: { steps: [] },
      decisions: [],
      files: { touched: [] },
      roles: { assignments: {} },
      git: null,
      handoff: {
        status: 'open',
        reason: null,
        reasonClass: null,
        toPlatformHint: null,
        finalizedAt: null,
        receive_log: [],
      },
      journalSeq: 0,
      compaction: { droppedDecisions: 0, note: null },
      dedupeRing: [],
    };

    assert.deepEqual(b, expected);
  });

  it('stamps createdAt and updatedAt from the provided nowIso', () => {
    const iso = '2027-01-02T03:04:05.678Z';
    const b = emptyBundle(INPUT, iso);
    assert.equal(b.createdAt, iso);
    assert.equal(b.updatedAt, iso);
  });

  it('produces output that passes validateBundle', () => {
    const r = validateBundle(emptyBundle(INPUT, NOW));
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
  });
});

describe('schema.validateBundle', () => {
  it('accepts a well-formed bundle with no errors', () => {
    const r = validateBundle(valid());
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
  });

  it('rejects a wrong schema string with a pathed error at "schema"', () => {
    const b = valid();
    b.schema = 'baton/bundle@2';
    const r = validateBundle(b);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.path === 'schema'), 'expected an error at path "schema"');
  });

  it('accepts each of the three legal handoff.status values', () => {
    for (const status of ['open', 'sealed', 'received']) {
      const b = valid();
      b.handoff.status = status;
      const r = validateBundle(b);
      assert.equal(r.ok, true, `status "${status}" should validate`);
    }
  });

  it('rejects a non-number journalSeq with a pathed error', () => {
    const b = valid();
    b.journalSeq = 'zero';
    const r = validateBundle(b);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.path === 'journalSeq'),
      'expected an error at path "journalSeq"',
    );
  });

  it('tolerates unknown extra fields (forward compatibility)', () => {
    const b = valid();
    b.somethingFromTheFuture = { nested: 42 };
    b.origin.futureFlag = true;
    const r = validateBundle(b);
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
  });

  it('accumulates one pathed error per distinct problem', () => {
    const b = valid();
    delete b.schema;
    b.journalSeq = 'x';
    b.plan.steps = 7;
    const r = validateBundle(b);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.path === 'schema'));
    assert.ok(r.errors.some((e) => e.path === 'journalSeq'));
    assert.ok(r.errors.some((e) => e.path === 'plan.steps'));
  });

  it('shapes every error as {path, msg} with non-empty strings', () => {
    const b = valid();
    delete b.schema;
    const r = validateBundle(b);
    assert.ok(r.errors.length >= 1);
    for (const e of r.errors) {
      assert.equal(typeof e.path, 'string');
      assert.ok(e.path.length > 0, 'error.path must be a non-empty string');
      assert.equal(typeof e.msg, 'string');
      assert.ok(e.msg.length > 0, 'error.msg must be a non-empty string');
    }
  });
});

// Table-driven "pathed error per missing field" coverage. core.md §Bundle schema
// requires an error whose path is rooted at each missing required field; a
// validator that silently ignored any of these would slip through, so every
// documented top-level field is exercised, not a hand-picked subset.
describe('schema.validateBundle — required top-level fields', () => {
  const REQUIRED = [
    'schema',
    'bundleId',
    'generation',
    'createdAt',
    'updatedAt',
    'origin',
    'task',
    'plan',
    'decisions',
    'files',
    'roles',
    'handoff',
    'journalSeq',
    'compaction',
    'dedupeRing',
  ];

  for (const field of REQUIRED) {
    it(`flags a missing "${field}" with ok:false and a pathed error rooted at "${field}"`, () => {
      const b = valid();
      delete b[field];
      const r = validateBundle(b);
      assert.equal(r.ok, false, `deleting "${field}" must invalidate the bundle`);
      assert.ok(
        r.errors.some((e) => e.path === field || e.path.startsWith(`${field}.`)),
        `expected an error whose path starts with "${field}"`,
      );
    });
  }
});

// Key nested constraints: missing nested requireds, an out-of-enum value, and
// wrong-typed collections. Each pins the dotted path at (or under) the offending
// nested field, per the {path, msg} dotted-path convention recorded above.
describe('schema.validateBundle — nested field constraints', () => {
  const CASES = [
    { name: 'origin.platform missing', path: 'origin.platform', mutate: (b) => { delete b.origin.platform; } },
    { name: 'task.goal missing', path: 'task.goal', mutate: (b) => { delete b.task.goal; } },
    { name: 'handoff.status set to an illegal value', path: 'handoff.status', mutate: (b) => { b.handoff.status = 'weird'; } },
    { name: 'plan.steps is not an array', path: 'plan.steps', mutate: (b) => { b.plan.steps = { not: 'an array' }; } },
    { name: 'files.touched is not an array', path: 'files.touched', mutate: (b) => { b.files.touched = 'nope'; } },
  ];

  for (const c of CASES) {
    it(`rejects ${c.name} with a pathed error at "${c.path}"`, () => {
      const b = valid();
      c.mutate(b);
      const r = validateBundle(b);
      assert.equal(r.ok, false, `${c.name} must invalidate the bundle`);
      assert.ok(
        r.errors.some((e) => e.path === c.path || e.path.startsWith(`${c.path}.`)),
        `expected an error whose path starts with "${c.path}"`,
      );
    });
  }
});

describe('schema.migrate', () => {
  it('is an identity (deep-equal) for a baton/bundle@1', () => {
    const b = valid();
    assert.deepEqual(migrate(b), b);
  });

  it('throws for baton/bundle@2 with a message naming the found schema', () => {
    const b = { ...valid(), schema: 'baton/bundle@2' };
    assert.throws(
      () => migrate(b),
      (err) => err instanceof Error && /baton\/bundle@2/.test(err.message),
      'migrate must throw an Error whose message names "baton/bundle@2"',
    );
  });
});
