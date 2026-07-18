import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// RED — smoke-approval token (subtask loop-state, part B). Source of truth:
// docs/plans/2026-07-18-goal-loop-worktree-pipeline.md §"Smoke gate": the
// approval token is a deterministic digest over {loop-state digest, smoke.cmd,
// smoke output digest, HEAD, content-sensitive git digest, child assignment};
// resuming recomputes it and REFUSES a drifted token, naming what moved
// (mirrors driftedInputs in core/src/receive/txn.mjs — a structured token).
//
// PINNED EXPORTS (core/src/loop/state.mjs):
//   smokeApprovalToken(inputs)            - deterministic digest string
//   verifySmokeToken(presented, inputs)   - {ok:true} | {ok:false, driftedInputs:[names]}
//
// PINNED INPUT FIELDS (the six bound inputs):
//   stateDigest, smokeCmd, smokeOutputDigest, gitHead, gitContentDigest, childAssignment
//
// RED MECHANISM: dynamic-import-with-catch + M() guard.
// ---------------------------------------------------------------------------

let mod = /** @type {any} */ (null);
let importError = /** @type {any} */ (null);
try {
  mod = await import('../../core/src/loop/state.mjs');
} catch (e) {
  importError = e;
}
function M() {
  assert.ok(mod, `core/src/loop/state.mjs must load (import error: ${importError?.message ?? 'none'})`);
  return mod;
}

const INPUTS = () => ({
  stateDigest: 'st-abc',
  smokeCmd: 'npm run smoke',
  smokeOutputDigest: 'out-123',
  gitHead: 'deadbeef',
  gitContentDigest: 'content-999',
  childAssignment: 'implementer=codex/gpt-5.6-sol',
});

// Each field -> a permissive needle the drift name must satisfy.
const FIELD_NEEDLE = {
  stateDigest: /state/i,
  smokeCmd: /cmd|command/i,
  smokeOutputDigest: /output/i,
  gitHead: /head/i,
  gitContentDigest: /content|git/i,
  childAssignment: /child|assignment/i,
};

// ===========================================================================
describe('smokeApprovalToken — deterministic digest over the bound inputs', () => {
  it('same inputs => same token', () => {
    const { smokeApprovalToken } = M();
    assert.equal(smokeApprovalToken(INPUTS()), smokeApprovalToken(INPUTS()), 'the token is a pure function of its inputs');
  });

  it('ANY single input change => a different token', () => {
    const { smokeApprovalToken } = M();
    const baseline = smokeApprovalToken(INPUTS());
    for (const field of Object.keys(INPUTS())) {
      const changed = { ...INPUTS(), [field]: `${INPUTS()[field]}-MOVED` };
      assert.notEqual(smokeApprovalToken(changed), baseline, `changing ${field} must change the token`);
    }
  });

  it('field boundaries are separated — a shifted split across two fields yields a DIFFERENT token (finding 3)', () => {
    const { smokeApprovalToken } = M();
    // Same six fields, but the boundary between stateDigest and smokeCmd moves:
    // a separator-less concatenation would collide ('xyz' either way).
    const a = smokeApprovalToken({ ...INPUTS(), stateDigest: 'x', smokeCmd: 'yz' });
    const b = smokeApprovalToken({ ...INPUTS(), stateDigest: 'xy', smokeCmd: 'z' });
    assert.notEqual(a, b, 'per-field boundaries must be preserved (no separator-less concatenation collision)');
  });
});

// ===========================================================================
describe('smokeApprovalToken / verifySmokeToken — partial inputs (finding 4)', () => {
  it('a missing bound field is rejected — the token cannot be computed from partial inputs', () => {
    const { smokeApprovalToken } = M();
    const partial = INPUTS();
    delete partial.gitHead; // a required bound input is absent
    assert.throws(() => smokeApprovalToken(partial), /gitHead|missing|required/i, 'computing a token over partial inputs must throw naming the gap');
  });

  it('verify is NEVER ok when the current inputs are partial (cannot re-derive)', () => {
    const { smokeApprovalToken, verifySmokeToken } = M();
    const token = smokeApprovalToken(INPUTS());
    const partial = INPUTS();
    delete partial.smokeOutputDigest;
    let r;
    assert.doesNotThrow(() => { r = verifySmokeToken(token, partial); }, 'verify must degrade gracefully, not throw, on partial inputs');
    assert.equal(r.ok, false, 'a token can never verify ok against partial current inputs');
  });
});

// ===========================================================================
describe('verifySmokeToken — recompute and name the drifted input(s)', () => {
  it('a token verifies ok against its own inputs', () => {
    const { smokeApprovalToken, verifySmokeToken } = M();
    const token = smokeApprovalToken(INPUTS());
    const r = verifySmokeToken(token, INPUTS());
    assert.equal(r.ok, true, 'unchanged inputs re-derive the same token');
  });

  it('a single drifted input => ok:false naming exactly that input', () => {
    const { smokeApprovalToken, verifySmokeToken } = M();
    const token = smokeApprovalToken(INPUTS());
    for (const [field, needle] of Object.entries(FIELD_NEEDLE)) {
      const drifted = { ...INPUTS(), [field]: `${INPUTS()[field]}-MOVED` };
      const r = verifySmokeToken(token, drifted);
      assert.equal(r.ok, false, `${field} drift must fail verification`);
      assert.ok(Array.isArray(r.driftedInputs) && r.driftedInputs.length > 0, 'driftedInputs is a non-empty array');
      assert.ok(r.driftedInputs.some((/** @type {string} */ n) => needle.test(n)), `driftedInputs names ${field}; got ${JSON.stringify(r.driftedInputs)}`);
    }
  });

  it('multiple drifted inputs are ALL named', () => {
    const { smokeApprovalToken, verifySmokeToken } = M();
    const token = smokeApprovalToken(INPUTS());
    const drifted = { ...INPUTS(), gitHead: 'moved-head', childAssignment: 'implementer=claude-code/claude-fable-5' };
    const r = verifySmokeToken(token, drifted);
    assert.equal(r.ok, false);
    assert.ok(r.driftedInputs.some((/** @type {string} */ n) => /head/i.test(n)), 'git head drift named');
    assert.ok(r.driftedInputs.some((/** @type {string} */ n) => /child|assignment/i.test(n)), 'child assignment drift named');
  });
});
