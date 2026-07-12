import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { loadSignatures } from '../detect/signatures.mjs';
import { classify } from '../detect/classifier.mjs';
import { emitEnvelope, parseFlags, usageError } from './shared.mjs';

const BUILTIN_SIGNATURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'signatures.v1.json');

/** @type {Record<string, number>} */
const EXIT_BY_CLASS = { ok: 0, 'usage-limit': 10, throttle: 11, auth: 12, 'other-error': 13 };

/**
 * `baton detect` — classify harness output / structured error types.
 * Exit codes ARE the verdict (frozen contract): 0 ok · 10 usage-limit ·
 * 11 throttle · 12 auth · 13 other-error · 2 usage error.
 * @param {string[]} args @param {any} io
 * @returns {number}
 */
export function cmdDetect(args, io) {
  const { flags } = parseFlags(args);
  const platform = typeof flags.platform === 'string' ? flags.platform : null;
  if (!platform) return usageError(io, flags, 'detect', '--platform <claude-code|codex|cursor> is required');

  let table;
  try {
    table = loadSignatures(
      {
        builtinPath: BUILTIN_SIGNATURES,
        overlayPath: typeof flags.signatures === 'string' ? flags.signatures : undefined,
      },
      io,
    );
  } catch (err) {
    const msg = /** @type {any} */ (err)?.message ?? String(err);
    if (flags.json) emitEnvelope(io, { ok: false, error: { code: 'bad-signatures', msg } });
    else io.stderr.write(`baton detect: ${msg}\n`);
    return 1;
  }

  const text = typeof flags.text === 'string' ? flags.text : typeof io.stdin === 'string' ? io.stdin : '';
  const exitCode = flags['exit-code'] !== undefined ? Number(flags['exit-code']) : 0;

  /** @type {{kind: string, errorType: string} | null} */
  let structured = null;
  if (typeof flags['structured-error-type'] === 'string') {
    structured = {
      kind: platform === 'codex' ? 'exec-json' : 'stop-failure',
      errorType: flags['structured-error-type'],
    };
  }

  const verdict = classify({ text, exitCode, platform, table, structured });
  const data = { ...verdict, tableVersion: table.schema, tableUpdated: table.updated };
  if (flags.explain) {
    data.tried = table.signatures.filter((/** @type {any} */ s) => s.platform === platform).map((/** @type {any} */ s) => s.id);
  }

  if (flags.json) {
    emitEnvelope(io, { ok: true, data });
  } else {
    io.stdout.write(`${verdict.class}${verdict.signatureId ? ` (${verdict.signatureId}, ${verdict.confidence})` : ''}${verdict.resetHint ? ` — resets ${verdict.resetHint}` : ''}\n`);
  }
  return EXIT_BY_CLASS[verdict.class] ?? 13;
}
