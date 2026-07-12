import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emptyBundle } from '../../core/src/bundle/schema.mjs';
import { applyEvent } from '../../core/src/bundle/merge.mjs';

// ---------------------------------------------------------------------------
// Gate-2 fix 6 (reviewer-a finding 8): journal events are untrusted input —
// replay must never store escaping paths or shapes that later crash render.
// Invalid payloads degrade to an audit note (a checkpoint never fails), and
// file paths are normalized + jailed before they enter files.touched.
// ---------------------------------------------------------------------------

const base = () => emptyBundle({ platform: 'claude-code', model: 'm', goal: 'g' }, '2026-07-12T00:00:00.000Z');
let n = 0;
const ev = (type, payload) => ({ seq: ++n, ts: '2026-07-12T00:00:01.000Z', type, dedupeKey: `k-${type}-${n}`, payload });

const lastNote = (b) => b.decisions[b.decisions.length - 1]?.summary ?? '';

describe('applyEvent — file.touch path jail', () => {
  it('refuses an absolute path: nothing stored, audit note recorded', () => {
    const out = applyEvent(base(), ev('file.touch', { path: '/etc/passwd', op: 'edit' }));
    assert.equal(out.files.touched.length, 0);
    assert.match(lastNote(out), /file\.touch/);
    assert.match(lastNote(out), /refused/i);
  });

  it('refuses an escaping traversal path', () => {
    const out = applyEvent(base(), ev('file.touch', { path: '../../home/u/.ssh/id_rsa', op: 'read' }));
    assert.equal(out.files.touched.length, 0);
    assert.match(lastNote(out), /refused/i);
  });

  it('stores the normalized form of a messy-but-safe path', () => {
    const out = applyEvent(base(), ev('file.touch', { path: './src//sub/../a.js', op: 'edit' }));
    assert.deepEqual(
      out.files.touched.map((f) => f.path),
      ['src/a.js'],
    );
  });

  it('dedupes by the normalized path, not the raw spelling', () => {
    let b = applyEvent(base(), ev('file.touch', { path: 'src/a.js', op: 'create' }));
    b = applyEvent(b, ev('file.touch', { path: './src/./a.js', op: 'edit' }));
    assert.equal(b.files.touched.length, 1);
    assert.equal(b.files.touched[0].op, 'edit');
  });
});

describe('applyEvent — payload shape hardening', () => {
  it('plan.set with a non-array steps payload degrades to a note', () => {
    const out = applyEvent(base(), ev('plan.set', { steps: 'do everything' }));
    assert.deepEqual(out.plan.steps, []);
    assert.match(lastNote(out), /plan\.set/);
  });

  it('plan.set with non-object entries degrades to a note', () => {
    const out = applyEvent(base(), ev('plan.set', { steps: ['a', 'b'] }));
    assert.deepEqual(out.plan.steps, []);
    assert.match(lastNote(out), /plan\.set/);
  });

  it('plan.step without an object payload carrying an id degrades to a note', () => {
    const out = applyEvent(base(), ev('plan.step', 'done'));
    assert.deepEqual(out.plan.steps, []);
    assert.match(lastNote(out), /plan\.step/);
  });

  it('roles.remap with a non-object assignments payload degrades to a note', () => {
    const out = applyEvent(base(), ev('roles.remap', { assignments: ['implementer'] }));
    assert.deepEqual(out.roles.assignments, {});
    assert.match(lastNote(out), /roles\.remap/);
  });

  it('roles.remap with a NULL assignment VALUE degrades to a note (iter-3 F3)', () => {
    // A well-formed assignments object whose VALUES are null used to be applied
    // verbatim, then crashed renderHandoffMd. The reducer must validate values.
    const out = applyEvent(base(), ev('roles.remap', { assignments: { planner: null } }));
    assert.deepEqual(out.roles.assignments, {}, 'the null-valued remap is refused, not stored');
    assert.match(lastNote(out), /roles\.remap/);
  });

  it('roles.remap with a non-object assignment VALUE degrades to a note (iter-3 F3)', () => {
    const out = applyEvent(base(), ev('roles.remap', { assignments: { planner: 'codex' } }));
    assert.deepEqual(out.roles.assignments, {});
    assert.match(lastNote(out), /roles\.remap/);
  });

  it('roles.remap with all-object assignment values is applied and renders (iter-3 F3)', async () => {
    const { renderHandoffMd } = await import('../../core/src/bundle/render.mjs');
    const out = applyEvent(base(), ev('roles.remap', { assignments: { planner: { platform: 'claude-code', model: 'm', mode: 'native' } } }));
    assert.deepEqual(out.roles.assignments, { planner: { platform: 'claude-code', model: 'm', mode: 'native' } });
    assert.doesNotThrow(() => renderHandoffMd(out), 'a valid remap renders cleanly');
  });

  it('task.update applies only typed known fields and drops the rest', () => {
    const out = applyEvent(base(), ev('task.update', { goal: 'new goal', constraints: 'be careful', acceptance: ['done'] }));
    assert.equal(out.task.goal, 'new goal');
    assert.deepEqual(out.task.constraints, [], 'a string constraints payload must not replace the array');
    assert.deepEqual(out.task.acceptance, ['done']);
  });

  it('task.update with nothing valid degrades to a note', () => {
    const out = applyEvent(base(), ev('task.update', { goal: 42, constraints: 'x' }));
    assert.equal(out.task.goal, 'g');
    assert.match(lastNote(out), /task\.update/);
  });

  it('git.update with a non-object payload degrades to a note', () => {
    const out = applyEvent(base(), ev('git.update', 'HEAD moved'));
    assert.equal(out.git, null);
    assert.match(lastNote(out), /git\.update/);
  });

  it('a bundle replayed through hostile events still renders (no crash downstream)', async () => {
    const { renderHandoffMd } = await import('../../core/src/bundle/render.mjs');
    let b = base();
    for (const e of [
      ev('file.touch', { path: '/abs' }),
      ev('plan.set', { steps: 'x' }),
      ev('roles.remap', { assignments: 'x' }),
      ev('task.update', { constraints: 'x' }),
      ev('git.update', 'x'),
      ev('file.touch', { path: 'ok/fine.js', op: 'edit' }),
    ]) {
      b = applyEvent(b, e);
    }
    const md = renderHandoffMd(b);
    assert.match(md, /ok\/fine\.js/);
  });
});
