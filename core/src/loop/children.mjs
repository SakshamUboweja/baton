/**
 * Child supervision — the loop's reliability surface. Owns the FULL child
 * lifecycle: argv assembly (per-role permissions), detached process-group
 * spawn with closed stdin, timeout SIGTERM→grace→SIGKILL of the whole group,
 * capped transcript logs, region-bounded verdict parsing (prompt-echo-proof),
 * and exit classification via core detect. Plan:
 * docs/plans/2026-07-18-goal-loop-worktree-pipeline.md §"Child supervision
 * contract".
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { classify } from '../detect/classifier.mjs';

// Every review seat is read-only — writers are the implementer-side roles
// only. The merger CHILD is read-only too: it adversarially re-checks, but
// the SUPERVISOR performs the actual merge via worktrees.mergeSubtask
// (pipeline contract — the merger child never issues git).
const REVIEWER_ROLES = new Set(['plan-reviewer', 'test-verifier', 'subtask-reviewer', 'final-reviewer-a', 'final-reviewer-b', 'merger']);

// AGENTS.md §9: children commit solely as the repo owner, zero AI attribution.
const GIT_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'SakshamUboweja',
  GIT_AUTHOR_EMAIL: 'ssakshamu@gmail.com',
  GIT_COMMITTER_NAME: 'SakshamUboweja',
  GIT_COMMITTER_EMAIL: 'ssakshamu@gmail.com',
});

/**
 * Assemble the spawn contract for a role child. Reviewers are read-only on
 * every platform; every child is marked supervised (its own baton hooks
 * no-op), carries the sole-author git identity, and has stdin CLOSED at
 * spawn (the codex-exec stdin-hang field failure).
 * @param {{platform: string, role: string, model: string, effort?: string | null, mode?: string}} assignment
 * @param {string} prompt
 * @param {{root: string}} opts
 * @returns {{command: string, args: string[], env: Record<string, string>, stdio: any[], cwd: string}}
 */
export function buildChildArgv(assignment, prompt, opts) {
  const readOnly = REVIEWER_ROLES.has(assignment.role);
  const env = { BATON_SUPERVISED_CHILD: '1', ...GIT_IDENTITY };
  const stdio = ['ignore', 'pipe', 'pipe'];

  if (assignment.platform === 'claude-code') {
    // --model honors the role matrix (and entry-level avoidance);
    // --output-format json is what parseVerdict's claude branch reads; the
    // cwd puts the child in its seat, never the supervisor cwd.
    const args = ['-p', prompt, '--model', assignment.model, '--output-format', 'json'];
    if (readOnly) {
      // Scoped read-only git so a reviewer can actually SEE the diff it
      // reviews — still no write/edit capability.
      args.push('--permission-mode', 'default', '--allowedTools', 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*)');
    } else {
      args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Grep,Glob,Write,Edit,Bash');
    }
    return { command: 'claude', args, env, stdio, cwd: opts.root };
  }

  // codex (and the default shape for exec-style CLIs).
  const args = ['exec', '-C', opts.root, '-s', readOnly ? 'read-only' : 'workspace-write', '--model', assignment.model];
  if (assignment.effort) args.push('-c', `model_reasoning_effort=${assignment.effort}`);
  args.push(prompt);
  return { command: 'codex', args, env, stdio, cwd: opts.root };
}

const VERDICT_RE = /VERDICT:\s*(APPROVED_WITH_NOTES|APPROVED|BLOCKED)\b/g;

/** @param {string} region @returns {{verdict: string, findings: string} | null} */
function lastVerdictIn(region) {
  let last = null;
  for (const m of region.matchAll(VERDICT_RE)) last = m;
  if (!last) return null;
  const after = region.slice((last.index ?? 0) + last[0].length);
  return { verdict: last[1], findings: after.trim() };
}

/**
 * Region-bounded verdict parsing — the prompt region (which quotes the
 * verdict format in its instructions) is NEVER scanned, and there is no
 * whole-transcript fallback. Unparseable is BLOCKED, never APPROVED.
 * - codex: only the text after the LAST line starting with 'tokens used'.
 * - claude-code: only the `result` field of the structured JSON output.
 * Multiple tails inside the trusted region → the LAST one wins.
 * @param {string} transcript @param {{platform: string}} opts
 * @returns {{verdict: string, findings: string, reason?: string}}
 */
export function parseVerdict(transcript, { platform }) {
  const unparseable = { verdict: 'BLOCKED', findings: '', reason: 'unparseable' };
  const text = String(transcript ?? '');

  if (platform === 'claude-code') {
    let obj = null;
    try {
      obj = JSON.parse(text.trim());
    } catch {
      return unparseable;
    }
    if (typeof obj?.result !== 'string') return unparseable;
    const hit = lastVerdictIn(obj.result);
    return hit ?? unparseable;
  }

  // codex: locate the LAST 'tokens used' marker line; the trusted region is
  // strictly after it.
  const lines = text.split('\n');
  let markerLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^tokens used\b/i.test(lines[i])) markerLine = i;
  }
  if (markerLine === -1) return unparseable;
  const region = lines.slice(markerLine + 1).join('\n');
  const hit = lastVerdictIn(region);
  return hit ?? unparseable;
}

const TRUNCATION_MARKER = '\n[... truncated by baton log cap ...]\n';

/**
 * Cap a transcript: head preserved, middle replaced with a marker, TAIL
 * preserved verbatim (the verdict lives at the end and must never be cut).
 * @param {string} text @param {number} maxBytes
 * @returns {string}
 */
export function capLog(text, maxBytes) {
  const s = String(text ?? '');
  if (Buffer.byteLength(s) <= maxBytes) return s;
  const headBytes = Math.max(1, Math.floor(maxBytes * 0.4));
  const tailBytes = Math.max(1, maxBytes - headBytes);
  const buf = Buffer.from(s);
  const head = buf.subarray(0, headBytes).toString();
  const tail = buf.subarray(buf.length - tailBytes).toString();
  return head + TRUNCATION_MARKER + tail;
}

/**
 * Exit classification delegates to core detect — one classifier, one
 * signature table, no drift. Returns exactly classify(...).class.
 * @param {string} transcript @param {number} exitCode @param {string} platform @param {any} table
 * @returns {string}
 */
export function classifyChildExit(transcript, exitCode, platform, table) {
  return classify({ text: transcript, exitCode, platform, table }).class;
}

/** @param {number} pid @param {NodeJS.Signals} sig */
function killGroup(pid, sig) {
  try {
    process.kill(-pid, sig);
  } catch {
    // ESRCH — already gone.
  }
}

/**
 * Spawn and supervise one child: detached in its OWN process group, stdin
 * closed; on timeout SIGTERM the group, wait graceMs, SIGKILL the group (no
 * zombie grandchildren). Output streams to a capped log at opts.logPath; the
 * verdict is parsed from the full transcript, region-bounded.
 * @param {{command: string, args: string[], env?: Record<string, string>, cwd?: string}} spec
 * @param {{timeoutMs: number, graceMs: number, logPath: string, maxLogBytes?: number, platform?: string, onStart?: (info: {pid: number, pgid: number}) => void}} opts
 * @returns {Promise<{timedOut: boolean, exitCode: number | null, verdict?: string, findings?: string, reason?: string, logPath: string, pgid?: number}>}
 */
export function superviseChild(spec, opts) {
  return new Promise((resolve) => {
    const maxLogBytes = opts.maxLogBytes ?? 1_000_000;
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...(spec.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // its own process group — the kill unit
    });

    // Report the group at spawn time so the supervisor can persist it BEFORE
    // the child completes — a supervisor crash leaves the orphan reap-able.
    const pgid = typeof child.pid === 'number' ? child.pid : -1;
    if (typeof opts.onStart === 'function' && typeof child.pid === 'number') {
      opts.onStart({ pid: child.pid, pgid });
    }

    let out = '';
    let timedOut = false;
    /** @type {NodeJS.Timeout | null} */
    let killTimer = null;

    const onChunk = (/** @type {Buffer} */ c) => {
      out += c.toString();
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    const timeout = setTimeout(() => {
      timedOut = true;
      if (typeof child.pid === 'number') {
        killGroup(child.pid, 'SIGTERM');
        killTimer = setTimeout(() => {
          if (typeof child.pid === 'number') killGroup(child.pid, 'SIGKILL');
        }, opts.graceMs);
      }
    }, opts.timeoutMs);

    const finish = (/** @type {number | null} */ exitCode) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      // Belt-and-braces: reap any group survivors even on a clean exit path.
      if (timedOut && typeof child.pid === 'number') killGroup(child.pid, 'SIGKILL');
      try {
        mkdirSync(dirname(opts.logPath), { recursive: true });
        writeFileSync(opts.logPath, capLog(out, maxLogBytes));
      } catch {
        // The log must never mask the result.
      }
      const parsed = parseVerdict(out, { platform: opts.platform ?? 'codex' });
      resolve({
        timedOut,
        exitCode: timedOut ? null : exitCode,
        verdict: parsed.verdict,
        findings: parsed.findings,
        ...(parsed.reason ? { reason: parsed.reason } : {}),
        logPath: opts.logPath,
        pgid,
      });
    };

    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}
