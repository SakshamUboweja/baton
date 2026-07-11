import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent } from '../../core/src/bundle/merge.mjs';

// ---------------------------------------------------------------------------
// Contract choices recorded for this module (docs/design/core.md §Bundle schema,
// §Module APIs; plan §Concurrency "idempotent via dedupeKey ring (500)";
// §Checkpoint engine event semantics). Readings the tests pin where the spec was
// open:
//   1. IDEMPOTENCY KEY = event.dedupeKey (the event carries its own key; the
//      shape is {seq, ts, type, dedupeKey, writerId, source, payload}). The
//      reducer treats event.dedupeKey as the ring key. To stay robust even if an
//      implementation recomputes the key from event content, every distinct
//      fixture event here has BOTH a distinct dedupeKey field AND distinct
//      content, and idempotency is exercised by re-applying the *identical*
//      event object.
//   2. A decision / note log entry carries exactly {seq, ts, summary} and, when
//      the event supplies one, `detail`. When no detail is present the `detail`
//      key is OMITTED (not set to null) — the cleanest JSON, and the forward-
//      compatible validator tolerates either reading anyway.
//   3. An UNKNOWN event type degrades to a single decision-log entry carrying the
//      event's seq/ts and a non-empty string `summary`. The exact wording is left
//      to the implementation, but the summary MUST name the unknown event's type
//      string (so the degraded note is actually informative, not a blank stub).
//   4. Every applyEvent (including duplicates and unknown types) bumps
//      updatedAt := event.ts and journalSeq := max(journalSeq, event.seq). For a
//      duplicate these are no-ops because the values are already set, so
//      re-applying the same event stays deep-equal.
// ---------------------------------------------------------------------------

const T0 = '2026-07-11T00:00:00.000Z';

// A fresh, minimal baton/bundle@1 for reduction. Built as a literal (not via
// schema.mjs) so this file's red phase is attributable to merge.mjs alone.
function baseBundle(overrides = {}) {
  const b = {
    schema: 'baton/bundle@1',
    bundleId: 'b_testbundle00000',
    generation: 1,
    createdAt: T0,
    updatedAt: T0,
    origin: { platform: 'claude-code', model: 'm', sessionHint: null, unstable: false },
    task: { goal: 'g', constraints: [], acceptance: [] },
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
  return { ...b, ...overrides };
}

// Event factory with sane defaults; override per test.
function ev(overrides = {}) {
  return {
    seq: 1,
    ts: '2026-07-11T01:00:00.000Z',
    type: 'note',
    dedupeKey: 'k-default',
    writerId: 'claude-code-1234',
    source: 'stop',
    payload: {},
    ...overrides,
  };
}

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

describe('merge.applyEvent — event types', () => {
  it('decision: appends {seq, ts, summary, detail}, bumps clock, records dedupeKey', () => {
    const ts = '2026-07-11T02:00:00.000Z';
    const out = applyEvent(
      baseBundle(),
      ev({ type: 'decision', seq: 5, ts, dedupeKey: 'd1', payload: { summary: 'chose X', detail: 'because Y' } }),
    );

    assert.equal(out.decisions.length, 1);
    assert.deepEqual(out.decisions[0], { seq: 5, ts, summary: 'chose X', detail: 'because Y' });
    assert.equal(out.updatedAt, ts);
    assert.equal(out.journalSeq, 5);
    assert.ok(out.dedupeRing.includes('d1'), 'dedupeKey should be recorded in the ring');
  });

  it('decision without detail: appends {seq, ts, summary} and omits detail', () => {
    const ts = '2026-07-11T02:05:00.000Z';
    const out = applyEvent(
      baseBundle(),
      ev({ type: 'decision', seq: 2, ts, dedupeKey: 'd2', payload: { summary: 'no detail here' } }),
    );
    assert.equal(out.decisions.length, 1);
    assert.deepEqual(out.decisions[0], { seq: 2, ts, summary: 'no detail here' });
  });

  it('note: appends a decision whose summary is the note text', () => {
    const ts = '2026-07-11T02:10:00.000Z';
    const out = applyEvent(
      baseBundle(),
      ev({ type: 'note', seq: 3, ts, dedupeKey: 'n1', payload: { text: 'remember this' } }),
    );
    assert.equal(out.decisions.length, 1);
    assert.deepEqual(out.decisions[0], { seq: 3, ts, summary: 'remember this' });
  });

  it('plan.set: replaces plan.steps entirely', () => {
    const start = baseBundle();
    start.plan.steps = [{ id: 'old', title: 'Old', status: 'done', note: null }];
    const steps = [
      { id: 'a', title: 'A', status: 'pending', note: null },
      { id: 'b', title: 'B', status: 'active', note: null },
    ];
    const out = applyEvent(start, ev({ type: 'plan.set', seq: 4, dedupeKey: 'ps', payload: { steps } }));
    assert.deepEqual(out.plan.steps, steps);
  });

  it('plan.step: patches an existing step by id and leaves siblings untouched', () => {
    const start = baseBundle();
    start.plan.steps = [
      { id: 'a', title: 'A', status: 'pending', note: null },
      { id: 'b', title: 'B', status: 'pending', note: null },
    ];
    const out = applyEvent(
      start,
      ev({ type: 'plan.step', seq: 6, dedupeKey: 'p1', payload: { id: 'a', status: 'done', note: 'ok' } }),
    );
    assert.equal(out.plan.steps.length, 2);
    assert.deepEqual(out.plan.steps[0], { id: 'a', title: 'A', status: 'done', note: 'ok' });
    assert.deepEqual(out.plan.steps[1], { id: 'b', title: 'B', status: 'pending', note: null });
  });

  it('plan.step: an unknown id appends a new step', () => {
    const start = baseBundle();
    start.plan.steps = [{ id: 'a', title: 'A', status: 'pending', note: null }];
    const out = applyEvent(
      start,
      ev({ type: 'plan.step', seq: 7, dedupeKey: 'p2', payload: { id: 'z', title: 'Z', status: 'active', note: 'new' } }),
    );
    assert.equal(out.plan.steps.length, 2);
    assert.deepEqual(out.plan.steps[1], { id: 'z', title: 'Z', status: 'active', note: 'new' });
  });

  it('file.touch: a new path appends {path, op, lastTs}', () => {
    const ts = '2026-07-11T03:00:00.000Z';
    const out = applyEvent(
      baseBundle(),
      ev({ type: 'file.touch', seq: 8, ts, dedupeKey: 'f1', payload: { path: 'b.js', op: 'create' } }),
    );
    assert.equal(out.files.touched.length, 1);
    assert.deepEqual(out.files.touched[0], { path: 'b.js', op: 'create', lastTs: ts });
  });

  it('file.touch: an existing path upserts op and refreshes lastTs (no duplicate)', () => {
    const start = baseBundle();
    start.files.touched = [{ path: 'a.js', op: 'edit', lastTs: '2026-07-11T00:00:00.000Z' }];
    const ts = '2026-07-11T03:30:00.000Z';
    const out = applyEvent(
      start,
      ev({ type: 'file.touch', seq: 9, ts, dedupeKey: 'f2', payload: { path: 'a.js', op: 'delete' } }),
    );
    assert.equal(out.files.touched.length, 1, 'upsert must not create a duplicate path entry');
    assert.deepEqual(out.files.touched[0], { path: 'a.js', op: 'delete', lastTs: ts });
  });

  it('roles.remap: replaces roles.assignments', () => {
    const start = baseBundle();
    start.roles.assignments = { implementer: { platform: 'x', model: 'old' } };
    const assignments = { planner: { platform: 'claude-code', model: 'm' } };
    const out = applyEvent(start, ev({ type: 'roles.remap', seq: 10, dedupeKey: 'r1', payload: { assignments } }));
    assert.deepEqual(out.roles.assignments, assignments);
  });

  it('task.update: merges payload into task, preserving untouched fields', () => {
    const start = baseBundle();
    start.task = { goal: 'g', constraints: [], acceptance: ['a1'] };
    const out = applyEvent(
      start,
      ev({ type: 'task.update', seq: 11, dedupeKey: 't1', payload: { goal: 'g2', constraints: ['c1'] } }),
    );
    assert.deepEqual(out.task, { goal: 'g2', constraints: ['c1'], acceptance: ['a1'] });
  });

  it('git.update: replaces git wholesale (from null and from an existing value)', () => {
    const fromNull = applyEvent(
      baseBundle(),
      ev({ type: 'git.update', seq: 12, dedupeKey: 'g1', payload: { branch: 'main', headSha: 'abc', dirty: false } }),
    );
    assert.deepEqual(fromNull.git, { branch: 'main', headSha: 'abc', dirty: false });

    const start = baseBundle();
    start.git = { branch: 'old', headSha: 'zzz', dirty: true };
    const replaced = applyEvent(
      start,
      ev({ type: 'git.update', seq: 13, dedupeKey: 'g2', payload: { branch: 'new' } }),
    );
    assert.deepEqual(replaced.git, { branch: 'new' }, 'git.update replaces, it does not merge');
  });

  it('unknown type: degrades to a decision-log entry, never throws, still bumps the clock', () => {
    const ts = '2026-07-11T04:00:00.000Z';
    let out;
    assert.doesNotThrow(() => {
      out = applyEvent(
        baseBundle(),
        ev({ type: 'totally.unknown', seq: 14, ts, dedupeKey: 'u1', payload: { text: 'huh', extra: 1 } }),
      );
    });
    assert.equal(out.decisions.length, 1, 'unknown type appends exactly one decision-log entry');
    assert.equal(out.decisions[0].seq, 14);
    assert.equal(out.decisions[0].ts, ts);
    const summary = out.decisions[0].summary;
    assert.equal(typeof summary, 'string');
    assert.ok(summary.length > 0, 'the degraded summary must be a non-empty string');
    assert.ok(
      summary.includes('totally.unknown'),
      'the degraded summary must name the unknown event type ("totally.unknown")',
    );
    assert.equal(out.updatedAt, ts);
    assert.equal(out.journalSeq, 14);
    assert.ok(out.dedupeRing.includes('u1'));
  });
});

describe('merge.applyEvent — bookkeeping', () => {
  it('bumps updatedAt to the event timestamp', () => {
    const ts = '2026-07-11T05:00:00.000Z';
    const out = applyEvent(baseBundle(), ev({ ts, dedupeKey: 'b1', payload: { text: 'x' } }));
    assert.equal(out.updatedAt, ts);
  });

  it('sets journalSeq to max(existing, event.seq): a lower seq does not lower it', () => {
    const start = baseBundle({ journalSeq: 10 });
    const lower = applyEvent(start, ev({ seq: 4, dedupeKey: 'b2', payload: { text: 'x' } }));
    assert.equal(lower.journalSeq, 10, 'a lower seq must not decrease journalSeq');

    const higher = applyEvent(start, ev({ seq: 20, dedupeKey: 'b3', payload: { text: 'y' } }));
    assert.equal(higher.journalSeq, 20, 'a higher seq must advance journalSeq');
  });

  it('records one ring key per distinct event', () => {
    let b = baseBundle();
    b = applyEvent(b, ev({ seq: 1, dedupeKey: 'x1', payload: { text: 'a' } }));
    b = applyEvent(b, ev({ seq: 2, dedupeKey: 'x2', payload: { text: 'b' } }));
    b = applyEvent(b, ev({ seq: 3, dedupeKey: 'x3', payload: { text: 'c' } }));
    assert.equal(b.dedupeRing.length, 3);
    assert.ok(['x1', 'x2', 'x3'].every((k) => b.dedupeRing.includes(k)));
  });
});

describe('merge.applyEvent — idempotency and the 500-key dedupe ring', () => {
  it('applying the same event twice yields a deep-equal bundle', () => {
    const e = ev({ type: 'decision', seq: 5, ts: '2026-07-11T06:00:00.000Z', dedupeKey: 'same', payload: { summary: 's' } });
    const once = applyEvent(baseBundle(), e);
    const twice = applyEvent(once, e);
    assert.deepEqual(twice, once, 're-applying an event already in the ring must be a no-op');
  });

  it('caps the ring at 500 keys, evicts oldest; an evicted event re-applies while a recent one stays deduped', () => {
    // 501 DISTINCT decision events (distinct dedupeKey AND distinct content).
    const events = [];
    for (let i = 1; i <= 501; i += 1) {
      events.push(
        ev({
          type: 'decision',
          seq: i,
          ts: '2026-07-11T07:00:00.000Z',
          dedupeKey: `k${i}`,
          payload: { summary: `s${i}` },
        }),
      );
    }

    let b = baseBundle();
    for (const e of events) b = applyEvent(b, e);

    // All 501 applied (merge does not compact); ring capped at 500, oldest gone.
    assert.equal(b.decisions.length, 501);
    assert.equal(b.dedupeRing.length, 500, 'ring must be capped at 500 keys');
    assert.ok(b.dedupeRing.includes('k501'), 'the most recent key must still be in the ring');
    assert.ok(!b.dedupeRing.includes('k1'), 'the oldest key must have been evicted');

    // Re-applying the most-recent event (still in ring) is a no-op.
    const afterRecent = applyEvent(b, events[500]);
    assert.equal(afterRecent.decisions.length, 501, 'a still-ringed event must not re-apply');

    // Re-applying the evicted first event applies again.
    const afterEvicted = applyEvent(b, events[0]);
    assert.equal(afterEvicted.decisions.length, 502, 'an evicted event must apply again');
    assert.equal(afterEvicted.decisions[afterEvicted.decisions.length - 1].summary, 's1');
  });
});

describe('merge.applyEvent — purity', () => {
  it('does not mutate a deeply-frozen input bundle', () => {
    const frozen = deepFreeze(baseBundle());
    let out;
    assert.doesNotThrow(() => {
      out = applyEvent(
        frozen,
        ev({ type: 'decision', seq: 1, dedupeKey: 'p1', payload: { summary: 'x', detail: 'y' } }),
      );
    });
    assert.notEqual(out, frozen, 'applyEvent must return a new bundle object');
    assert.notEqual(out.decisions, frozen.decisions, 'the decisions array must be a fresh array');
  });

  it('leaves the input deep-equal before and after (clone comparison)', () => {
    const input = baseBundle();
    const snapshot = structuredClone(input);
    applyEvent(input, ev({ type: 'file.touch', seq: 1, dedupeKey: 'p2', payload: { path: 'a.js', op: 'edit' } }));
    assert.deepEqual(input, snapshot, 'applyEvent must not mutate its input bundle');
  });
});
