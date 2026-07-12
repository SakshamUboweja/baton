import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { bundlePaths, loadBundle, writeSnapshot, rotateJournal } from '../bundle/store.mjs';
import { snapshot as gitSnapshot } from '../git/snapshot.mjs';
import { loadSignatures } from '../detect/signatures.mjs';
import { classify } from '../detect/classifier.mjs';
import { emitEnvelope, parseFlags, resolveRoot, usageError } from './shared.mjs';

const BUILTIN_SIGNATURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'signatures.v1.json');

/**
 * Infer the reason class by running the reason text through the classifier
 * against the bundle's origin platform. No signature match reads as 'ok',
 * which is not a switch reason — degrade to null rather than mislabel.
 * @param {string} reason @param {string} platform @param {any} io
 * @returns {string | null}
 */
function inferReasonClass(reason, platform, io) {
  try {
    const table = loadSignatures({ builtinPath: BUILTIN_SIGNATURES }, io);
    const verdict = classify({ text: reason, exitCode: 0, platform, table, structured: null });
    return verdict.class === 'ok' ? null : verdict.class;
  } catch {
    return null;
  }
}

/**
 * `baton finalize` — the narrative seal: records the switch reason, refreshes
 * git state, seals the bundle, and freezes this generation into history via a
 * 'finalize' journal rotation.
 * @param {string[]} args @param {any} io
 * @returns {Promise<number>}
 */
export async function cmdFinalize(args, io) {
  const { flags } = parseFlags(args);
  const reason = typeof flags.reason === 'string' ? flags.reason : null;
  if (!reason) return usageError(io, flags, 'finalize', '--reason "<why you are switching>" is required');
  const REASON_CLASSES = ['usage-limit', 'auth', 'throttle', 'other-error'];
  if (flags['reason-class'] !== undefined && !REASON_CLASSES.includes(/** @type {string} */ (flags['reason-class']))) {
    return usageError(io, flags, 'finalize', `--reason-class must be one of ${REASON_CLASSES.join('|')}`);
  }

  const root = resolveRoot(io, flags);
  const paths = bundlePaths(root);
  const { bundle, warnings } = loadBundle(root, io);
  for (const w of warnings) io.stderr.write(`baton finalize: ${w}\n`);
  if (bundle === null) {
    const error = { code: 'no-bundle', msg: `no handoff bundle at ${paths.snapshot}; nothing to finalize` };
    if (flags.json) emitEnvelope(io, { ok: false, error });
    else io.stderr.write(`baton finalize: ${error.msg}\n`);
    return 1;
  }

  const git = await gitSnapshot({ execFile: io.execFile, cwd: root, fs: io.fs });
  if (git === null) io.stderr.write('baton finalize: git state unavailable — sealing without a git refresh\n');

  const reasonClass =
    typeof flags['reason-class'] === 'string' ? flags['reason-class'] : inferReasonClass(reason, bundle.origin.platform, io);

  const sealed = {
    ...bundle,
    git: git ?? bundle.git,
    updatedAt: io.now(),
    handoff: {
      ...bundle.handoff,
      status: 'sealed',
      reason,
      reasonClass,
      toPlatformHint: typeof flags.to === 'string' ? flags.to : null,
      finalizedAt: io.now(),
    },
  };

  writeSnapshot(root, sealed, io);
  rotateJournal(root, 'finalize', io);

  if (flags.json) {
    emitEnvelope(io, { ok: true, data: { bundlePath: paths.snapshot, handoffMdPath: paths.handoffMd } });
  } else {
    io.stdout.write(`sealed — reason: ${reason}${reasonClass ? ` (${reasonClass})` : ''}${sealed.handoff.toPlatformHint ? ` — next: ${sealed.handoff.toPlatformHint}` : ''}\n`);
  }
  return 0;
}
