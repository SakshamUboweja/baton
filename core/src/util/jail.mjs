// Threat-model guards (plan §Threat model): bundle-borne paths and the managed
// .handoff tree are untrusted input. jailRelPath is the single pure gate every
// repository path passes through before storage or render; checkHandoffTree
// refuses to operate on a managed tree that contains symlinks or resolves
// outside the repository root.

const NUL = String.fromCharCode(0);

/**
 * Normalize an untrusted repository-relative path, or return null when it is
 * unsafe: non-string, empty, NUL bytes, absolute (posix, Windows drive, UNC),
 * or escaping the root via `..`. Backslashes are treated as separators so a
 * Windows spelling cannot smuggle a traversal past a posix check.
 * @param {any} p
 * @returns {string | null}
 */
export function jailRelPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.includes(NUL)) return null;
  const unified = p.replace(/\\/g, '/');
  if (unified.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(unified)) return null;
  /** @type {string[]} */
  const out = [];
  for (const seg of unified.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  if (out.length === 0) return null;
  return out.join('/');
}

/** Thrown by store mutations when the managed tree fails the jail check. */
export class UnsafeTreeError extends Error {}

/**
 * Verify the managed .handoff tree is safe to operate on: the directory itself
 * is not a symlink, its realpath stays under the repository root, and no entry
 * anywhere in the tree is a symlink (lstat walk — never follows links). An
 * absent tree is safe; an unverifiable tree is refused, never trusted.
 * @param {string} root @param {any} io
 * @returns {{ok: true} | {ok: false, problem: string}}
 */
export function checkHandoffTree(root, io) {
  const dir = `${root}/.handoff`;
  try {
    if (!io.fs.existsSync(dir)) return { ok: true };
    if (io.fs.lstatSync(dir).isSymbolicLink()) {
      return { ok: false, problem: `.handoff is a symlink — refusing to operate through a linked managed tree` };
    }
    const rootReal = io.fs.realpathSync(root);
    const dirReal = io.fs.realpathSync(dir);
    if (dirReal !== `${rootReal}/.handoff`) {
      return { ok: false, problem: `.handoff resolves outside the repository root (${dirReal}) — refusing` };
    }
    // Walk is race-tolerant (gate-2 iter-2): under concurrent atomic writes
    // the tree churns — tmp files, the lock dir, and rotated journals appear
    // and vanish between readdir and lstat. An entry that disappears mid-walk
    // (ENOENT) is normal concurrency, NOT a symlink attack, so it is skipped;
    // only a POSITIVELY observed symlink refuses. The stable top-level checks
    // above (.handoff itself a symlink / realpath escape) stay strict.
    /** @type {string[]} */
    const stack = [dir];
    while (stack.length > 0) {
      const d = /** @type {string} */ (stack.pop());
      /** @type {string[]} */
      let names;
      try {
        names = io.fs.readdirSync(d);
      } catch (e) {
        if (/** @type {any} */ (e)?.code === 'ENOENT') continue; // subdir removed mid-walk
        throw e;
      }
      for (const name of names) {
        const p = `${d}/${name}`;
        let st;
        try {
          st = io.fs.lstatSync(p);
        } catch (e) {
          if (/** @type {any} */ (e)?.code === 'ENOENT') continue; // entry vanished mid-walk
          throw e;
        }
        if (st.isSymbolicLink()) return { ok: false, problem: `${p} is a symlink — refusing (managed-tree jail)` };
        if (st.isDirectory()) stack.push(p);
      }
    }
    return { ok: true };
  } catch (err) {
    const msg = /** @type {any} */ (err)?.message ?? String(err);
    return { ok: false, problem: `managed tree could not be verified (${msg}) — refusing` };
  }
}

/**
 * Assert form of checkHandoffTree for mutation paths: throws UnsafeTreeError
 * so commands surface the refusal through their existing soft-failure handling.
 * @param {string} root @param {any} io
 */
export function assertHandoffTreeSafe(root, io) {
  const r = checkHandoffTree(root, io);
  if (!r.ok) throw new UnsafeTreeError(r.problem);
}
