// Single Claude Code hook entrypoint. hooks.json routes every event here with
// the event name as argv[0]; this script's only job is to reach the core CLI
// (never re-implement it) and to stay fail-open: a hook must never break the
// host session, so every path returns 0.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** @param {any} io */
const batonBin = (io) => `${io.env?.CLAUDE_PLUGIN_ROOT ?? '.'}/core/bin/baton.mjs`;

/**
 * execFile-shaped spawn that supports {input}: async execFile has no input
 * option, and a child reading stdin would otherwise block forever (gate-2
 * reviewer-b finding 1). The io contract for this adapter is therefore
 * "promise execFile honoring opts.input as the child's stdin".
 * @param {string} cmd @param {string[]} args @param {{cwd?: string, input?: string, timeout?: number}} [opts]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function execFileWithInput(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 25_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const e = Object.assign(new Error(`Command failed: ${cmd}`), { code, stdout, stderr });
      reject(e);
    });
    if (typeof opts.input === 'string' && child.stdin) child.stdin.write(opts.input);
    child.stdin?.end();
  });
}

/**
 * Run a core baton command as a child process, forwarding the raw hook payload
 * as the child's stdin. Rejections are swallowed (fail-open) — core commands
 * carry their own hook-safety, and Claude ignores hook exit codes anyway.
 * @param {any} io @param {string[]} argv
 */
async function baton(io, argv) {
  try {
    await io.execFile('node', [batonBin(io), ...argv], { input: io.stdin });
  } catch {
    // fail-open: a failing child must not break the session
  }
}

/** @param {any} io @returns {any | null} parsed hook payload, or null */
function parsePayload(io) {
  try {
    return JSON.parse(typeof io.stdin === 'string' ? io.stdin : '');
  } catch {
    return null;
  }
}

/**
 * SessionStart: not a checkpoint. If a pending bundle from ANOTHER platform
 * exists (sealed, or open-but-limit-hit — the unsealed limit death), inject a
 * receive suggestion via the Claude context shape. Own-platform bundles are
 * this session's own work; quiet no-op.
 * @param {any} io
 */
function sessionStart(io) {
  let bundle;
  try {
    bundle = JSON.parse(io.fs.readFileSync(`${io.cwd}/.handoff/bundle.json`, 'utf8'));
  } catch {
    return 0;
  }
  const origin = bundle?.origin?.platform;
  const pending = bundle?.handoff?.status === 'sealed' || bundle?.handoff?.reasonClass === 'usage-limit';
  const foreign = typeof origin === 'string' && origin !== 'claude-code';
  if (pending && foreign) {
    io.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `A handoff bundle from ${origin} is pending in .handoff/ (${bundle.handoff.status === 'sealed' ? 'sealed' : 'limit-hit before sealing'}). Suggest running /baton:receive to resume that task with remapped roles.`,
        },
      }) + '\n',
    );
  }
  return 0;
}

/**
 * @param {string[]} args argv after the script path; args[0] is the hook event
 * @param {any} io injected {cwd, env, stdin, stdout, stderr, fs, execFile, now, …}
 * @returns {Promise<number>} always 0 — fail-open by construction
 */
export async function runHook(args, io) {
  try {
    const event = args[0] ?? 'unknown';

    if (event === 'SessionStart') return sessionStart(io);

    if (event === 'StopFailure') {
      const errorType = parsePayload(io)?.error?.type;
      const detectArgs = ['detect', '--platform', 'claude-code'];
      if (typeof errorType === 'string') detectArgs.push('--structured-error-type', errorType);
      await baton(io, detectArgs);
      await baton(io, ['checkpoint', '--platform', 'claude-code']);
      return 0;
    }

    // Stop / PreCompact / SessionEnd — and any future event — are routine
    // mechanical checkpoints; core normalize degrades unknown payloads safely.
    await baton(io, ['checkpoint', '--platform', 'claude-code']);
    return 0;
  } catch {
    return 0;
  }
}

// Main entry: hooks.json executes this file directly (`node …/hook.mjs <Event>`),
// so a real invocation must build the real io and run — an export alone is a
// production no-op (gate-2 reviewer-b finding 1).
const isMain = (() => {
  try {
    return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
  } catch {
    return false;
  }
})();

if (isMain) {
  let stdin = '';
  try {
    if (!process.stdin.isTTY) stdin = readFileSync(0, 'utf8');
  } catch {
    stdin = '';
  }
  const io = {
    cwd: process.cwd(),
    env: process.env,
    stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    fs: nodeFs,
    execFile: execFileWithInput,
    now: () => new Date().toISOString(),
  };
  runHook(process.argv.slice(2), io).then(
    (code) => process.exit(code),
    () => process.exit(0),
  );
}
