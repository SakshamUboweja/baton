import { loadBundle } from '../bundle/store.mjs';
import { resolveRoot, parseFlagsStrict, usageError, emitEnvelope, platformError } from './shared.mjs';

// Per-platform receive pointers and context shapes (plan §adapters; gate-2
// fix 8). Claude Code injects hookSpecificOutput.additionalContext, Cursor
// expects additional_context JSON, Codex surfaces plain hook stdout.
/** @type {Record<string, string>} */
const RESUME_HINT = {
  'claude-code': 'Suggest running /baton:receive to resume that task with remapped roles.',
  codex: "Run 'baton receive --platform codex' or the baton-handoff skill to resume that task with remapped roles.",
  cursor: "Run 'baton receive --platform cursor' to resume that task with remapped roles.",
};

/**
 * `baton session-start` — the cheap SessionStart gate the adapters call
 * instead of full receive preparation (gate-2 fix 8). Inspects only
 * pending-foreign state: a bundle that is sealed OR limit-hit AND from
 * another platform yields a harness-shaped notice on stdout; every other state
 * — own bundle, open non-limit bundle, no bundle, corrupt tree — is a quiet
 * no-op. Soft paths ALWAYS exit 0 (a session-start notice must never break a
 * session); a mis-parsed invocation is a broken hook manifest, which is loud
 * (exit 2) so init/doctor drift gets noticed. With --json (surface-audit fold)
 * the standard envelope wraps the outcome so machine consumers can tell "no
 * pending handoff" from a swallowed failure: data = {pending, shaped}.
 * @param {string[]} args @param {any} io
 * @returns {Promise<number>}
 */
export async function cmdSessionStart(args, io) {
  const parsed = parseFlagsStrict(args, { platform: 'string' });
  if (parsed.error !== undefined) return usageError(io, parsed.flags, 'session-start', parsed.error);
  const flags = parsed.flags;
  const finish = (/** @type {boolean} */ pending, /** @type {any} */ shaped) => {
    if (flags.json === true) emitEnvelope(io, { ok: true, data: { pending, shaped } });
    else if (shaped !== null) io.stdout.write(typeof shaped === 'string' ? `${shaped}\n` : JSON.stringify(shaped) + '\n');
    return 0;
  };
  try {
    const platform = typeof flags.platform === 'string' ? flags.platform : null;
    if (!platform || platformError(platform) !== null) {
      io.stderr.write('baton session-start: --platform <claude-code|codex|cursor> is required — emitting nothing\n');
      return finish(false, null);
    }

    const root = resolveRoot(io, flags);
    // Full load (journal replay included): an unsealed limit death may live
    // only as a post-snapshot journal note. Load warnings are deliberately
    // not surfaced — this is a notice path, not a diagnostics path.
    const { bundle } = loadBundle(root, io);
    if (bundle === null) return finish(false, null);

    const origin = bundle?.origin?.platform;
    const pending = bundle?.handoff?.status === 'sealed' || bundle?.handoff?.reasonClass === 'usage-limit';
    const foreign = typeof origin === 'string' && origin !== platform;
    if (!pending || !foreign) return finish(false, null);

    const kind = bundle.handoff.status === 'sealed' ? 'sealed' : 'limit-hit before sealing';
    const msg = `A handoff bundle from ${origin} is pending in .handoff/ (${kind}). ${RESUME_HINT[platform] ?? RESUME_HINT.codex}`;

    if (platform === 'cursor') return finish(true, { additional_context: msg });
    if (platform === 'claude-code') return finish(true, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg } });
    return finish(true, msg);
  } catch {
    return finish(false, null);
  }
}
