import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../../core/src/util/redact.mjs';

// ---------------------------------------------------------------------------
// Gate-2 fix 10 / plan §Transcript policy: transcript tails pass through a
// secret-redaction filter before storage. Planted-secret fixtures prove each
// pattern class; ordinary prose and code survive untouched.
// ---------------------------------------------------------------------------

// [label, fixture text, the exact secret fragment that MUST be absent after
// redaction] — every fixture carries its own forbidden fragment so a partial
// redaction can never slip past a lookup regex (test-verifier finding 2).
const PLANTED = [
  ['anthropic/openai style key', 'my key is sk-ant-api03-AbCdEfGh1234567890xyz', 'sk-ant-api03-AbCdEfGh1234567890xyz'],
  ['aws access key id', 'export AWS_KEY=AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
  ['github token', 'push with ghp_16C7e42F292c6912E7710c838347Ae178B4a', 'ghp_16C7e42F292c6912E7710c838347Ae178B4a'],
  ['slack token', 'slack: xoxb-2508459822-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx', 'xoxb-2508459822-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'],
  ['bearer header', 'Authorization: Bearer eyAbCdEf0123456789.abcdef0123456789', 'eyAbCdEf0123456789.abcdef0123456789'],
  ['jwt', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'eyJhbGciOiJIUzI1NiJ9'],
  ['generic api_key assignment', 'api_key = "hunter2hunter2hunter2"', 'hunter2hunter2hunter2'],
  ['password assignment', 'password: supersecret99', 'supersecret99'],
  ['pem private key', ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA7bq4', '-----END RSA PRIVATE KEY-----'].join('\n'), 'MIIEowIBAAKCAQEA7bq4'],
];

describe('redactSecrets — planted secrets are removed', () => {
  for (const [label, text, forbidden] of PLANTED) {
    it(`redacts ${label}`, () => {
      const out = redactSecrets(text);
      assert.match(out, /\[redacted\]/, `expected a redaction marker in: ${out}`);
      assert.ok(!out.includes(forbidden), `secret fragment survived redaction: ${out}`);
    });
  }

  it('leaves ordinary prose and code untouched', () => {
    const text = 'Refactor applyEvent in merge.mjs; the dedupe ring caps at 500 entries. See docs/design/core.md.';
    assert.equal(redactSecrets(text), text);
  });

  it('non-string and empty inputs return the empty string, never a throw', () => {
    assert.equal(redactSecrets(''), '');
    assert.equal(redactSecrets(null), '');
    assert.equal(redactSecrets(undefined), '');
    assert.equal(redactSecrets(42), '');
    assert.equal(redactSecrets({ tail: 'x' }), '');
  });
});
