import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { emptyBundle, validateBundle } from '../../core/src/bundle/schema.mjs';
import { applyEvent } from '../../core/src/bundle/merge.mjs';
import { renderHandoffMd } from '../../core/src/bundle/render.mjs';
import { loadBundle } from '../../core/src/bundle/store.mjs';
import { cmdCheckpoint } from '../../core/src/commands/checkpoint.mjs';

// ---------------------------------------------------------------------------
// Gate-2 iteration-2 findings B4 (reviewer-a #6) + B6 (reviewer-a #12):
// nested-shape validation must reject a null/non-object roles assignment value
// (it crashed renderHandoffMd), replay must survive a parseable null / non-object
// journal line (it crashed before applyEvent), and the auto-seed must be a
// SELF-APPLYING event so a journal-only rebuild restores origin/identity, not
// just a decision note.
// ---------------------------------------------------------------------------

const T0 = '2026-07-12T00:00:00.000Z';
const base = () => emptyBundle({ platform: 'claude-code', model: 'm', goal: 'g' }, T0);

describe('validateBundle — assignment value shapes (B4)', () => {
  it('rejects a null assignment value (the render-crash repro)', () => {
    const b = base();
    b.roles.assignments = { planner: null };
    const r = validateBundle(b);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.path === 'roles.assignments.planner'), JSON.stringify(r.errors));
  });

  it('rejects a non-object assignment value', () => {
    const b = base();
    b.roles.assignments = { planner: 'claude-code/m' };
    assert.equal(validateBundle(b).ok, false);
  });

  it('a bundle that passes validation renders without throwing', () => {
    const b = base();
    b.roles.assignments = { planner: { platform: 'claude-code', model: 'm', mode: 'native' } };
    assert.equal(validateBundle(b).ok, true);
    assert.doesNotThrow(() => renderHandoffMd(b));
  });
});

describe('replay survives hostile journal envelopes (B4)', () => {
  it('a parseable null journal line is skipped with a warning, never a crash', () => {
    const io = makeIo({
      files: {
        '/repo/.handoff/bundle.json': JSON.stringify(base(), null, 2) + '\n',
        '/repo/.handoff/journal.ndjson':
          'null\n' +
          JSON.stringify({ seq: 1, ts: T0, type: 'decision', dedupeKey: 'k1', payload: { summary: 'real-one' } }) + '\n' +
          '42\n' +
          '"a bare string"\n',
      },
    });
    const { bundle, warnings } = loadBundle('/repo', io);
    assert.ok(bundle, 'load did not crash on the null/number/string lines');
    assert.ok(bundle.decisions.some((/** @type {any} */ d) => d.summary === 'real-one'), 'the valid event still applied');
    assert.ok(warnings.some((w) => /skip|malformed|non-object|envelope/i.test(w)), `a skip warning is surfaced: ${JSON.stringify(warnings)}`);
  });

  it('applyEvent tolerates a null/garbage event directly (no throw)', () => {
    assert.doesNotThrow(() => applyEvent(base(), null));
    assert.doesNotThrow(() => applyEvent(base(), 'nope'));
    assert.doesNotThrow(() => applyEvent(base(), 42));
  });
});

describe('auto-seed is a self-applying event (B6)', () => {
  it('journal-only rebuild restores origin platform/model, bundleId, and task', async () => {
    const io = makeIo({ stdin: JSON.stringify({ schema: 'baton/event@1', type: 'decision', payload: { summary: 'work-1' }, sessionHint: 's', unstable: false }), now: T0 });
    assert.equal(await cmdCheckpoint(['--platform', 'claude-code', '--model', 'claude-fable-5'], io), 0);

    const seeded = JSON.parse(io.files()['/repo/.handoff/bundle.json']);
    const originalId = seeded.bundleId;
    assert.equal(seeded.origin.platform, 'claude-code');

    // Destroy snapshot AND backup: the journal alone must rebuild the identity.
    io.fs.unlinkSync('/repo/.handoff/bundle.json');
    io.fs.rmSync('/repo/.handoff/bundle.json.bak', { force: true });

    const { bundle } = loadBundle('/repo', io);
    assert.ok(bundle, 'journal-only rebuild works');
    assert.equal(bundle.origin.platform, 'claude-code', 'origin platform restored from the seed event (not "unknown")');
    assert.equal(bundle.origin.model, 'claude-fable-5', 'origin model restored');
    assert.equal(bundle.bundleId, originalId, 'bundleId restored — same bundle identity survives a journal-only rebuild');
    assert.equal(bundle.task.goal, seeded.task.goal, 'task goal restored');
    assert.ok(bundle.decisions.some((/** @type {any} */ d) => d.summary === 'work-1'), 'later work still replays on top');
  });
});
