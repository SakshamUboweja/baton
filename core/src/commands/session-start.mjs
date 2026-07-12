import { loadBundle } from '../bundle/store.mjs';
import { parseFlags, resolveRoot } from './shared.mjs';

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
 * `baton session-start` — the cheap SessionStart gate the Codex and Cursor
 * adapters call instead of full receive preparation (gate-2 fix 8). Inspects
 * only pending-foreign state: a bundle that is sealed OR limit-hit AND from
 * another platform yields a harness-shaped notice on stdout; every other state
 * — own bundle, open non-limit bundle, no bundle, corrupt tree — is a quiet
 * no-op. ALWAYS exits 0: a session-start notice must never break a session.
 * @param {string[]} args @param {any} io
 * @returns {Promise<number>}
 */
export async function cmdSessionStart(args, io) {
  try {
    const { flags } = parseFlags(args);
    const platform = typeof flags.platform === 'string' ? flags.platform : null;
    if (!platform) {
      io.stderr.write('baton session-start: --platform <claude-code|codex|cursor> is required — emitting nothing\n');
      return 0;
    }

    const root = resolveRoot(io, flags);
    // Full load (journal replay included): an unsealed limit death may live
    // only as a post-snapshot journal note. Load warnings are deliberately
    // not surfaced — this is a notice path, not a diagnostics path.
    const { bundle } = loadBundle(root, io);
    if (bundle === null) return 0;

    const origin = bundle?.origin?.platform;
    const pending = bundle?.handoff?.status === 'sealed' || bundle?.handoff?.reasonClass === 'usage-limit';
    const foreign = typeof origin === 'string' && origin !== platform;
    if (!pending || !foreign) return 0;

    const kind = bundle.handoff.status === 'sealed' ? 'sealed' : 'limit-hit before sealing';
    const msg = `A handoff bundle from ${origin} is pending in .handoff/ (${kind}). ${RESUME_HINT[platform] ?? RESUME_HINT.codex}`;

    if (platform === 'cursor') {
      io.stdout.write(JSON.stringify({ additional_context: msg }) + '\n');
    } else if (platform === 'claude-code') {
      io.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg } }) + '\n');
    } else {
      io.stdout.write(msg + '\n');
    }
    return 0;
  } catch {
    return 0;
  }
}
