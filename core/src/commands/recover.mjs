import { recoverLock } from '../bundle/lock.mjs';
import { emitEnvelope, resolveRoot, parseFlagsStrict, usageError } from './shared.mjs';

/**
 * `baton recover` — explicit lock recovery (gate-2 fix 11: this sat in the
 * frozen command list unimplemented). Exactly ONE state recovers: a
 * provably-dead same-host owner. `--force` is an intent flag only — live,
 * cross-host, and torn-metadata locks refuse with the same reasons either way
 * (plan §Concurrency: never steal on uncertainty).
 * @param {string[]} args @param {any} io
 * @returns {Promise<number>}
 */
export async function cmdRecover(args, io) {
  const parsed = parseFlagsStrict(args, { force: 'boolean' });
  if (parsed.error !== undefined) return usageError(io, parsed.flags, 'recover', parsed.error);
  const flags = parsed.flags;
  const root = resolveRoot(io, flags);
  const r = recoverLock(root, io, { force: flags.force === true });

  if (r.recovered) {
    if (flags.json) emitEnvelope(io, { ok: true, data: { recovered: true } });
    else io.stdout.write('baton recover: lock recovered (or already free) — nothing holds .handoff/lock\n');
    return 0;
  }
  if (flags.json) {
    emitEnvelope(io, { ok: false, data: { recovered: false }, error: { code: 'refused', msg: r.refusedReason ?? 'refused' } });
  } else {
    io.stderr.write(`baton recover: ${r.refusedReason}\n`);
  }
  return 1;
}
