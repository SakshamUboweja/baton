import { bundlePaths } from '../bundle/store.mjs';
import { withLock, LockHeldError } from '../bundle/lock.mjs';
import { atomicWriteText, atomicWriteJson } from '../util/fsx.mjs';
import { emitEnvelope, parseFlags } from './shared.mjs';

/**
 * Remove every property named `transcript` anywhere in a JSON value.
 * @param {any} v
 * @returns {any}
 */
function stripTranscript(v) {
  if (Array.isArray(v)) return v.map(stripTranscript);
  if (v !== null && typeof v === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === 'transcript') continue;
      out[k] = stripTranscript(val);
    }
    return out;
  }
  return v;
}

/** @param {any} io @param {string} dir @returns {string[]} */
function walk(io, dir) {
  /** @type {string[]} */
  const out = [];
  if (!io.fs.existsSync(dir)) return out;
  for (const name of io.fs.readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (io.fs.statSync(p).isDirectory()) out.push(...walk(io, p));
    else out.push(p);
  }
  return out;
}

/** @param {any} io @param {string} path */
function scrubJsonFile(io, path) {
  const raw = io.fs.readFileSync(path, 'utf8');
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // unparseable snapshots are the recovery ladder's problem, not purge's
  }
  const stripped = stripTranscript(parsed);
  const next = JSON.stringify(stripped, null, 2) + '\n';
  if (JSON.stringify(stripped) !== JSON.stringify(parsed)) atomicWriteText(io.fs, path, next);
}

/** @param {any} io @param {string} path */
function scrubLinesFile(io, path) {
  const raw = io.fs.readFileSync(path, 'utf8');
  let changed = false;
  const lines = raw.split('\n').map((/** @type {string} */ line) => {
    if (line.trim() === '') return line;
    /** @type {any} */
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return line; // tolerate foreign lines verbatim
    }
    const stripped = stripTranscript(parsed);
    const next = JSON.stringify(stripped);
    if (next !== JSON.stringify(parsed)) {
      changed = true;
      return next;
    }
    return line;
  });
  if (changed) atomicWriteText(io.fs, path, lines.join('\n'));
}

/**
 * `baton purge-transcript` — scrub the opt-in transcript field from EVERY
 * retained copy under .handoff/ (active snapshot, .bak, journal, history
 * freezes + rotated journals, diagnostics log). Marker-guarded so an
 * interrupted purge resumes until the whole tree is clean; runs under the repo
 * lock so a live foreign session blocks it entirely.
 * @param {string[]} args @param {any} io
 * @returns {Promise<number>}
 */
export async function cmdPurgeTranscript(args, io) {
  const { flags } = parseFlags(args);
  const p = bundlePaths(io.cwd);
  const markerPath = `${p.dir}/purge.marker.json`;

  if (!io.fs.existsSync(p.dir)) {
    if (flags.json) emitEnvelope(io, { ok: true, data: { purged: 0, note: 'no .handoff directory — nothing to purge' } });
    else io.stdout.write('purge-transcript: no .handoff directory — nothing to purge\n');
    return 0;
  }

  try {
    withLock(io.cwd, io, () => {
      atomicWriteJson(io.fs, markerPath, { startedAt: io.now() });
      for (const file of walk(io, p.dir)) {
        if (file === markerPath) continue;
        if (/\.(ndjson|jsonl)$/.test(file)) scrubLinesFile(io, file);
        else if (/\.(json|bak)$/.test(file)) scrubJsonFile(io, file);
      }
      io.fs.unlinkSync(markerPath);
    });
  } catch (err) {
    const msg = /** @type {any} */ (err)?.message ?? String(err);
    const code = err instanceof LockHeldError ? 'lock-held' : 'purge-failed';
    if (flags.json) emitEnvelope(io, { ok: false, error: { code, msg } });
    else io.stderr.write(`baton purge-transcript: ${msg}\n`);
    return 1;
  }

  if (flags.json) emitEnvelope(io, { ok: true, data: { note: 'transcript fields removed from every retained copy under .handoff/' } });
  else io.stdout.write('purge-transcript: transcript fields removed from every retained copy under .handoff/\n');
  return 0;
}
