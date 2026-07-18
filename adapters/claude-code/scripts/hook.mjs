// Single Claude Code hook entrypoint. hooks.json routes every event here with
// the event name as argv[0]; this script's only job is to reach the core CLI
// (never re-implement it) and to stay fail-open: a hook must never break the
// host session, so every path returns 0.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkHandoffTree } from '../../../core/src/util/jail.mjs';

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
    // Fail-open (audit finding 21): a child that dies without draining a large
    // stdin payload emits an out-of-band EPIPE 'error' on stdin that bypasses
    // every try/catch and crashes the hook with a stack trace. Swallow it —
    // the close handler still reports the child's real exit.
    child.stdin?.on('error', () => {});
    if (typeof opts.input === 'string' && child.stdin) child.stdin.write(opts.input);
    child.stdin?.end();
  });
}

// Hook-error diagnostics (gate-2 minor 16 / plan §Transcript policy log
// contract): metadata-only entries — never the hook payload — with bounded
// retention (last 50 entries / 7 days). The log rides .handoff/ so the purge
// walk covers it.
const HOOK_LOG_MAX = 50;
const HOOK_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** @param {any} io @param {string} event @param {any} err */
function logHookError(io, event, err) {
  try {
    // The diagnostics log rides .handoff/, so it passes the same managed-tree
    // jail as every other write (threat model): refuse to create or write
    // through a symlinked/escaped .handoff. Diagnostics must never be the hole
    // the jail closes elsewhere — and this stays fail-open (skip, don't throw).
    if (!checkHandoffTree(io.cwd, io).ok) return;
    const dir = `${io.cwd}/.handoff/log`;
    io.fs.mkdirSync(dir, { recursive: true });
    const path = `${dir}/hook-errors.jsonl`;
    const nowIso = typeof io.now === 'function' ? io.now() : new Date().toISOString();
    /** @type {any[]} */
    let entries = [];
    try {
      entries = io.fs
        .readFileSync(path, 'utf8')
        .split('\n')
        .filter((/** @type {string} */ l) => l.trim() !== '')
        .map((/** @type {string} */ l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      entries = [];
    }
    entries.push({ ts: nowIso, event, code: err?.code ?? null });
    const cutoff = Date.parse(nowIso) - HOOK_LOG_MAX_AGE_MS;
    entries = entries.filter((e) => typeof e.ts === 'string' && Date.parse(e.ts) >= cutoff).slice(-HOOK_LOG_MAX);
    io.fs.writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  } catch {
    // diagnostics must never break fail-open
  }
}

/**
 * Run a core baton command as a child process, forwarding the raw hook payload
 * as the child's stdin. Rejections are swallowed (fail-open) — core commands
 * carry their own hook-safety, and Claude ignores hook exit codes anyway —
 * but each failure leaves a metadata-only diagnostic in .handoff/log/.
 * opts.acceptCodes: exit codes that are VERDICTS, not failures (audit finding
 * 20: detect's 10/11/12/13 classification exits were logged as hook errors on
 * every real limit death, drowning the diagnostics log in noise).
 * @param {any} io @param {string[]} argv @param {string} event
 * @param {{timeout?: number, acceptCodes?: number[]}} [opts]
 * @returns {Promise<{stdout: string, stderr: string} | null>}
 */
async function baton(io, argv, event, opts = {}) {
  try {
    return await io.execFile('node', [batonBin(io), ...argv], { input: io.stdin, timeout: opts.timeout });
  } catch (err) {
    if (Array.isArray(opts.acceptCodes) && opts.acceptCodes.includes(/** @type {any} */ (err)?.code)) {
      const e = /** @type {any} */ (err);
      return { stdout: e?.stdout ?? '', stderr: e?.stderr ?? '' };
    }
    // fail-open: a failing child must not break the session
    logHookError(io, event, err);
    return null;
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
 * SessionStart: not a checkpoint — delegate to the core `session-start`
 * command (audit finding 19: the old inline version read
 * `${io.cwd}/.handoff/bundle.json` raw, so launching Claude Code in a repo
 * SUBDIRECTORY silently never fired the pending-handoff notice while the same
 * session's Stop checkpoints DID land at the discovered toplevel). Core owns
 * root discovery, the managed-tree jail, and the origin allowlist; this shim
 * only forwards the shaped stdout the harness consumes.
 * @param {any} io
 */
async function sessionStart(io) {
  const r = await baton(io, ['session-start', '--platform', 'claude-code'], 'SessionStart', { timeout: 8_000 });
  if (r && typeof r.stdout === 'string' && r.stdout.length > 0) io.stdout.write(r.stdout);
  return 0;
}

/**
 * @param {string[]} args argv after the script path; args[0] is the hook event
 * @param {any} io injected {cwd, env, stdin, stdout, stderr, fs, execFile, now, …}
 * @returns {Promise<number>} always 0 — fail-open by construction
 */
export async function runHook(args, io) {
  try {
    // Supervised loop children never touch or read any bundle: fast-path out
    // before spawning anything (mirrors core isSupervisedChild — this script
    // runs standalone, so the check is inlined).
    const supervised = io?.env?.BATON_SUPERVISED_CHILD;
    if (typeof supervised === 'string' && supervised.length > 0) return 0;

    const event = args[0] ?? 'unknown';

    if (event === 'SessionStart') return sessionStart(io);

    if (event === 'StopFailure') {
      // CHECKPOINT FIRST (audit finding 22): it is the part that must land
      // before the harness's 30s envelope kills the hook — the limit-death
      // checkpoint is the whole point of this event. Explicit per-child
      // timeouts sum under the envelope (18s + 8s < 30s). detect runs second,
      // and its classification exit codes are VERDICTS, not errors (finding
      // 20) — only real failures (1/2/spawn) reach the diagnostics log.
      await baton(io, ['checkpoint', '--platform', 'claude-code', '--trigger', 'StopFailure'], event, { timeout: 18_000 });
      const errorType = parsePayload(io)?.error?.type;
      const detectArgs = ['detect', '--platform', 'claude-code'];
      if (typeof errorType === 'string') detectArgs.push('--structured-error-type', errorType);
      await baton(io, detectArgs, event, { timeout: 8_000, acceptCodes: [0, 10, 11, 12, 13, 14] });
      return 0;
    }

    // Stop / PreCompact / SessionEnd — and any future event — are routine
    // mechanical checkpoints; core normalize degrades unknown payloads safely.
    await baton(io, ['checkpoint', '--platform', 'claude-code'], event);
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
