import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emptyBundle, validateBundle } from '../../core/src/bundle/schema.mjs';

// ---------------------------------------------------------------------------
// Gate-2 fix 6 (reviewer-a finding 8): nested bundle shapes were unvalidated —
// a string task.constraints passed validation and then crashed renderHandoffMd,
// and absolute/`..` files.touched paths were stored verbatim. validateBundle
// now checks every shape render and the commands consume, and jails paths.
// ---------------------------------------------------------------------------

const base = () => emptyBundle({ platform: 'claude-code', model: 'm', goal: 'g' }, '2026-07-12T00:00:00.000Z');

/** @param {any} b @param {string} path */
function failsAt(b, path) {
  const r = validateBundle(b);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.path === path),
    `expected an error at ${path}, got ${JSON.stringify(r.errors)}`,
  );
}

describe('validateBundle — deep nested shapes', () => {
  it('a well-formed bundle still validates', () => {
    const b = base();
    b.task.constraints = ['tests green'];
    b.plan.steps = [{ id: 's1', title: 'do it', status: 'pending' }];
    b.decisions = [{ seq: 1, ts: 'ts', summary: 'chose x' }];
    b.files.touched = [{ path: 'src/a.js', op: 'edit', lastTs: 'ts' }];
    assert.deepEqual(validateBundle(b), { ok: true, errors: [] });
  });

  it("rejects the reviewer's render-crash repro: string task.constraints", () => {
    const b = base();
    b.task.constraints = 'be careful';
    failsAt(b, 'task.constraints');
  });

  it('rejects non-string entries inside task.constraints', () => {
    const b = base();
    b.task.constraints = ['fine', { evil: true }];
    failsAt(b, 'task.constraints[1]');
  });

  it('rejects non-array task.acceptance', () => {
    const b = base();
    b.task.acceptance = 'ship it';
    failsAt(b, 'task.acceptance');
  });

  it('rejects non-object plan steps', () => {
    const b = base();
    b.plan.steps = ['just a string'];
    failsAt(b, 'plan.steps[0]');
  });

  it('rejects non-object decision entries', () => {
    const b = base();
    b.decisions = ['loose string'];
    failsAt(b, 'decisions[0]');
  });

  it('rejects non-object files.touched entries', () => {
    const b = base();
    b.files.touched = ['src/a.js'];
    failsAt(b, 'files.touched[0]');
  });

  it('rejects absolute files.touched paths', () => {
    const b = base();
    b.files.touched = [{ path: '/etc/passwd', op: 'edit', lastTs: 'ts' }];
    failsAt(b, 'files.touched[0].path');
  });

  it('rejects escaping files.touched paths', () => {
    const b = base();
    b.files.touched = [{ path: '../../home/user/.ssh/id_rsa', op: 'read', lastTs: 'ts' }];
    failsAt(b, 'files.touched[0].path');
  });

  it('rejects non-object roles.assignments', () => {
    const b = base();
    b.roles.assignments = 'implementer=me';
    failsAt(b, 'roles.assignments');
  });

  it('rejects non-array handoff.receive_log', () => {
    const b = base();
    b.handoff.receive_log = 'received once';
    failsAt(b, 'handoff.receive_log');
  });
});
