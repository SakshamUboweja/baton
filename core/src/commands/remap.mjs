import { loadConfig } from '../roles/matrix.mjs';
import { resolveRoles } from '../roles/resolve.mjs';
import { emitEnvelope, parseFlags, usageError } from './shared.mjs';

/**
 * `baton remap` — resolve the committed role matrix for a destination platform.
 * Read-only: prints assignments, never mutates the bundle (receive owns that).
 * @param {string[]} args @param {any} io
 * @returns {number}
 */
export function cmdRemap(args, io) {
  const { flags } = parseFlags(args);
  const to = typeof flags.to === 'string' ? flags.to : null;
  if (!to) return usageError(io, flags, 'remap', '--to <claude-code|codex|cursor> is required');

  const { config, errors } = loadConfig(io.cwd, io);
  if (!config) {
    const msg = errors.map((e) => (e.path ? `${e.path}: ${e.msg}` : e.msg)).join('; ');
    if (flags.json) emitEnvelope(io, { ok: false, error: { code: 'bad-config', msg } });
    else io.stderr.write(`baton remap: ${msg}\n`);
    return 1;
  }

  const avoid = typeof flags.avoid === 'string' ? flags.avoid.split(',') : [];
  const { assignments, notes } = resolveRoles({
    config,
    to,
    avoid,
    nativeOnly: flags['native-only'] === true,
    probes: null,
  });

  if (flags.json) {
    emitEnvelope(io, { ok: true, data: { assignments, notes } });
  } else {
    for (const [role, a] of Object.entries(assignments)) {
      io.stdout.write(`${role}: ${a.platform ?? '—'}/${a.model ?? '—'}${a.effort ? `@${a.effort}` : ''} (${a.mode})\n`);
    }
  }
  return 0;
}
