import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const bin = join(repoRoot, 'core', 'bin', 'baton.mjs');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

function runBaton(args, cwd = repoRoot) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
}

describe('cli spawn (integration)', () => {
  it('--version exits 0 and prints the package.json version on stdout', () => {
    const r = runBaton(['--version']);
    assert.equal(r.status, 0);
    assert.ok(
      r.stdout.includes(pkg.version),
      `stdout should contain ${pkg.version}; got ${JSON.stringify(r.stdout)}`,
    );
  });

  it('unknown command exits 2 with usage on stderr', () => {
    const r = runBaton(['definitely-not-a-command']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage/i);
  });

  it('status --json with no bundle exits 1 and stdout is exactly one compact {ok:false,...} envelope + newline', () => {
    // A fresh empty dir guarantees no .handoff bundle and no config to discover.
    const cwd = mkdtempSync(join(tmpdir(), 'baton-cli-'));
    try {
      const r = runBaton(['status', '--json'], cwd);
      assert.equal(r.status, 1);

      // The --json envelope contract is byte-exact: exactly one COMPACT single-line
      // JSON value followed by a single '\n' on stdout — nothing else. No pretty-
      // printing, no leading/trailing whitespace, and no diagnostics leaking onto
      // stdout (those belong on stderr). Re-serializing the parsed value in compact
      // form and comparing to the raw stdout enforces all of that at once.
      const parsed = JSON.parse(r.stdout);
      assert.equal(r.stdout, JSON.stringify(parsed) + '\n');

      assert.equal(parsed.ok, false);
      assert.ok('data' in parsed, 'envelope must carry a data field');
      assert.ok('warnings' in parsed, 'envelope must carry a warnings field');
      assert.ok('error' in parsed, 'envelope must carry an error field');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('reserved `wrap` command exits 2 (usage) and stderr says it is reserved', () => {
    const r = runBaton(['wrap']);
    assert.equal(r.status, 2, `wrap should exit 2 (usage error); got ${r.status}`);
    assert.match(r.stderr, /reserved/i);
  });

  it('every documented command is recognized (routed), never falling to the unknown-command path', () => {
    // Full routing / exit-code-10-13 coverage is deferred to the cli-shell and
    // detect tasks (those modules must exist first). What is contractual now: each
    // documented command name is RECOGNIZED — it must not be dispatched down the
    // unknown-command exit path. A not-yet-implemented command may exit 1 with a
    // clear "not implemented" error, but it must never exit 2 or be reported as an
    // unknown command.
    const commands = [
      'checkpoint', 'finalize', 'detect', 'remap', 'receive',
      'init', 'doctor', 'status', 'purge-transcript', 'recover',
    ];

    // Baseline: a genuinely unknown command, invoked EXACTLY like the documented
    // ones (with --help), takes the usage/unknown exit path. Symmetric invocation
    // closes the loophole where a global --help handler runs before dispatch and
    // fakes recognition (test-verifier iteration-2 finding).
    const unknown = runBaton(['definitely-not-a-command', '--help']);
    assert.equal(unknown.status, 2, 'baseline unknown command must exit 2 even with --help');
    assert.match(unknown.stderr, /unknown command/i, 'baseline must be reported as unknown');

    for (const cmd of commands) {
      const r = runBaton([cmd, '--help']);
      const out = `${r.stdout}\n${r.stderr}`;

      assert.notEqual(
        r.status, 2,
        `${cmd}: recognized command must not exit 2 (usage/unknown path); got ${r.status}`,
      );
      assert.doesNotMatch(
        out, /unknown command/i,
        `${cmd}: recognized command must not emit unknown-command text`,
      );
      // Command-specific dispatch evidence: the output must name the command
      // itself (its help text or its not-implemented error), proving the route
      // exists rather than a shared pre-dispatch handler answering for it.
      assert.match(
        out, new RegExp(cmd.replace('-', '[-]'), 'i'),
        `${cmd}: output must reference the command itself as dispatch evidence`,
      );
    }
  });
});
