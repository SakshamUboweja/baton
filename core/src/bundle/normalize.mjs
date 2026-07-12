import { hostname } from 'node:os';

// Best-effort extraction of baton events from raw harness hook payloads.
// Total: any input value yields an Event[] — garbage degrades to note events,
// never a throw, so a checkpoint can never break the host harness.

/** @typedef {{host: string, pid: number, startTime: number | null}} SessionFacts */

/** @type {Record<string, string>} */
const FILE_TOOL_OPS = { Write: 'write', Edit: 'edit' };

/** @returns {SessionFacts} */
function processFacts() {
  return { host: hostname(), pid: process.pid, startTime: Math.round(performance.timeOrigin) };
}

/**
 * A process-scoped hint for payloads lacking a stable session id. Deterministic
 * over the identity facts: one process => one hint; unstable hints never
 * trigger foreign-session rejection on their own (enforced at the command).
 * @param {SessionFacts | undefined} session
 */
function generatedHint(session) {
  const f = session ?? processFacts();
  return ['unstable', f.host, f.pid, f.startTime].join(':');
}

/**
 * @param {any} raw
 * @param {SessionFacts | undefined} session
 * @returns {{sessionHint: string, unstable: boolean}}
 */
function deriveHint(raw, session) {
  const id = raw && typeof raw === 'object' ? raw.session_id : undefined;
  if (typeof id === 'string' && id.length > 0) return { sessionHint: id, unstable: false };
  return { sessionHint: generatedHint(session), unstable: true };
}

/**
 * Normalize a parsed hook payload into baton/event@1 events. Adapters that
 * already speak baton/event@1 pass through verbatim; raw per-harness payloads
 * get best-effort extraction; unknowns degrade to note events. Never throws.
 * @param {any} raw parsed JS value (the caller owns JSON.parse)
 * @param {string} platform 'claude-code' | 'codex' | 'cursor'
 * @param {SessionFacts} [session] identity facts for generated hints; defaults to this process
 * @param {string} [explicitEvent] the hook event name passed on the command line
 *   (`--trigger`). Authoritative when present — the hooks manifest already keys
 *   each command by event, so this needs no per-harness payload parsing. Cursor's
 *   stop payload carries neither `hook_event_name` nor `event`, so without this
 *   its checkpoint degraded to trigger 'unknown' and never satisfied the canary.
 * @returns {any[]}
 */
export function normalizeHookPayload(raw, platform, session, explicitEvent) {
  // Passthrough tier: the adapter formed the events; return them untouched.
  if (raw && typeof raw === 'object' && raw.schema === 'baton/event@1') {
    if (Array.isArray(raw.events)) return raw.events;
    return [raw];
  }

  const { sessionHint, unstable } = deriveHint(raw, session);
  /** @param {string} type @param {Record<string, any>} payload */
  const event = (type, payload) => ({ type, payload, source: platform, sessionHint, unstable });
  /** @param {string} trigger */
  const note = (trigger) => event('note', { trigger, text: 'hook ' + trigger + ' observed on ' + platform });

  const eventName =
    (typeof explicitEvent === 'string' && explicitEvent.length > 0 && explicitEvent) ||
    (raw && typeof raw === 'object'
      ? (typeof raw.hook_event_name === 'string' && raw.hook_event_name) ||
        (platform === 'cursor' && typeof raw.event === 'string' && raw.event) ||
        null
      : null);
  if (!eventName) return [note('unknown')];

  if (platform === 'claude-code') {
    if (eventName === 'PostToolUse') {
      const op = FILE_TOOL_OPS[raw.tool_name];
      const path = raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input.file_path : undefined;
      if (op && typeof path === 'string') return [event('file.touch', { path, op })];
      return [note('PostToolUse')];
    }
    if (eventName === 'StopFailure') {
      const errorType = raw.error && typeof raw.error === 'object' && typeof raw.error.type === 'string' ? raw.error.type : 'unknown';
      return [
        event('note', {
          trigger: 'StopFailure',
          text: 'turn ended on API error: ' + errorType,
          errorType,
          structured: { kind: 'stop-failure', errorType },
        }),
      ];
    }
    return [note(eventName)];
  }

  // Codex and Cursor (and any future platform string): every lifecycle event
  // is a note carrying its trigger; the harness is the source.
  return [note(eventName)];
}
