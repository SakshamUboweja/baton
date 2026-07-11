/**
 * Filesystem primitives with crash-safety discipline.
 * All functions take an injected fs-like object so tests run on a memfs fake.
 */

let tmpCounter = 0;

/** @param {string} path */
function tmpPathFor(path) {
  tmpCounter += 1;
  return `${path}.tmp.${process.pid}-${tmpCounter}`;
}

/**
 * Rename with retry on EPERM (Windows AV/indexer lock pattern): 3 attempts total.
 * @param {any} fs @param {string} from @param {string} to
 */
function renameWithRetry(fs, from, to) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      lastErr = err;
      if (!err || /** @type {any} */ (err).code !== 'EPERM') throw err;
    }
  }
  throw lastErr;
}

/**
 * Write text atomically: tmp sibling + rename. The live target is never
 * truncated or partially written.
 * @param {any} fs @param {string} path @param {string} content
 */
export function atomicWriteText(fs, path, content) {
  const tmp = tmpPathFor(path);
  fs.writeFileSync(tmp, content);
  try {
    renameWithRetry(fs, tmp, path);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // leftover tmp is harmless; cleanupTmp removes it later
    }
    throw err;
  }
}

/**
 * Atomically write pretty-printed JSON (2-space, trailing newline).
 * @param {any} fs @param {string} path @param {unknown} obj
 */
export function atomicWriteJson(fs, path, obj) {
  atomicWriteText(fs, path, JSON.stringify(obj, null, 2) + '\n');
}

/**
 * Read + parse JSON without ever throwing.
 * @param {any} fs @param {string} path
 * @returns {{ok: true, value: any} | {ok: false, error: string}}
 */
export function safeReadJson(fs, path) {
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (err) {
    return { ok: false, error: `read failed: ${/** @type {any} */ (err)?.code ?? err}` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: `parse failed: ${/** @type {any} */ (err)?.message ?? err}` };
  }
}

/**
 * Copy the current content to <path>.bak (when present), then write atomically.
 * @param {any} fs @param {string} path @param {string} content
 */
export function backupThenWrite(fs, path, content) {
  if (fs.existsSync(path)) {
    fs.copyFileSync(path, `${path}.bak`);
  }
  atomicWriteText(fs, path, content);
}

/**
 * Remove leftover *.tmp.* files in a directory (crash debris).
 * @param {any} fs @param {string} dir
 */
export function cleanupTmp(fs, dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (/\.tmp\./.test(name)) {
      try {
        fs.unlinkSync(`${dir}/${name}`);
      } catch {
        // already gone or locked; not fatal
      }
    }
  }
}

/**
 * @param {any} fs @param {string} path
 */
export function ensureDir(fs, path) {
  fs.mkdirSync(path, { recursive: true });
}
