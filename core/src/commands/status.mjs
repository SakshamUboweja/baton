import { loadBundle } from '../bundle/store.mjs';
import { emitEnvelope, parseFlags, resolveRoot } from './shared.mjs';

/**
 * `baton status` — report the active bundle THROUGH the recovery ladder
 * (gate-2 minor 16: the old inline version read bundle.json raw, so a corrupt
 * snapshot with a perfectly good .bak reported failure). Load warnings go to
 * stderr; --json carries them in the envelope.
 * @param {string[]} args @param {any} io
 * @returns {Promise<number>}
 */
export async function cmdStatus(args, io) {
  const { flags } = parseFlags(args);
  const root = resolveRoot(io, flags);
  const { bundle, warnings } = loadBundle(root, io);
  for (const w of warnings) io.stderr.write(`baton status: ${w}\n`);

  if (bundle === null) {
    const error = { code: 'no-bundle', msg: `no handoff bundle at ${root}/.handoff/bundle.json; run 'baton init' or let checkpoints create one` };
    if (flags.json) emitEnvelope(io, { ok: false, error, warnings });
    else io.stderr.write(`baton status: ${error.msg}\n`);
    return 1;
  }

  const data = {
    bundleId: bundle.bundleId ?? null,
    status: bundle.handoff?.status ?? null,
    generation: bundle.generation ?? null,
    updatedAt: bundle.updatedAt ?? null,
  };
  if (flags.json) emitEnvelope(io, { ok: true, data, warnings });
  else io.stdout.write(`bundle ${data.bundleId ?? '?'} — ${data.status ?? '?'} — generation ${data.generation ?? '?'} — updated ${data.updatedAt ?? '?'}\n`);
  return 0;
}
