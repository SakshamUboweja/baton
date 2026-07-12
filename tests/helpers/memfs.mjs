// In-memory fs fake for unit tests. Synchronous subset only.
// Atomicity contract: renameSync moves content in a single step, so a target
// path is never observed carrying partial content. Every mutation appends a
// full snapshot to `fs.__history`, letting tests enumerate intermediate states
// and prove the tmp+rename discipline (target's first appearance is a rename).

function fsError(code, syscall, path) {
  const e = new Error(`${code}: ${syscall} '${path}'`);
  e.code = code;
  e.syscall = syscall;
  e.path = path;
  return e;
}

function normalize(p) {
  const str = String(p);
  const isAbs = str.startsWith('/');
  const out = [];
  for (const part of str.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return (isAbs ? '/' : '') + out.join('/');
}

function dirname(np) {
  const i = np.lastIndexOf('/');
  if (i <= 0) return '/';
  return np.slice(0, i);
}

function basename(np, parent) {
  return parent === '/' ? np.slice(1) : np.slice(parent.length + 1);
}

export function makeMemfs(initialFiles = {}) {
  const store = new Map(); // path -> string content
  const dirs = new Set(['/']);
  const mtimes = new Map();
  const history = [];
  let clock = 0;

  const snapshot = () => Object.fromEntries(store);
  const record = (op, paths) => history.push({ op, paths, files: snapshot() });
  const touch = (np) => mtimes.set(np, ++clock);

  const mkdirp = (np) => {
    let cur = '';
    for (const part of np.split('/').filter(Boolean)) {
      cur = cur + '/' + part;
      dirs.add(cur);
    }
  };

  const ensureParent = (np, syscall) => {
    const parent = dirname(np);
    if (parent === '/' ) return;
    if (!dirs.has(parent)) throw fsError('ENOENT', syscall, np);
  };

  for (const [p, content] of Object.entries(initialFiles)) {
    const np = normalize(p);
    mkdirp(dirname(np));
    store.set(np, String(content));
    touch(np);
  }

  const fs = {
    readFileSync(p /*, enc */) {
      const np = normalize(p);
      if (!store.has(np)) throw fsError('ENOENT', 'open', np);
      return store.get(np);
    },

    writeFileSync(p, data /*, enc */) {
      const np = normalize(p);
      ensureParent(np, 'open');
      store.set(np, String(data));
      touch(np);
      record('writeFileSync', [np]);
    },

    appendFileSync(p, data) {
      const np = normalize(p);
      ensureParent(np, 'open');
      store.set(np, (store.get(np) || '') + String(data));
      touch(np);
      record('appendFileSync', [np]);
    },

    renameSync(from, to) {
      const nf = normalize(from);
      const nt = normalize(to);
      if (!store.has(nf)) throw fsError('ENOENT', 'rename', nf);
      ensureParent(nt, 'rename');
      const content = store.get(nf);
      store.delete(nf);
      store.set(nt, content);
      touch(nt);
      record('renameSync', [nf, nt]);
    },

    mkdirSync(p, opts = {}) {
      const np = normalize(p);
      if (opts.recursive) {
        mkdirp(np);
        record('mkdirSync', [np]);
        return undefined;
      }
      ensureParent(np, 'mkdir');
      if (dirs.has(np) || store.has(np)) throw fsError('EEXIST', 'mkdir', np);
      dirs.add(np);
      record('mkdirSync', [np]);
      return undefined;
    },

    existsSync(p) {
      const np = normalize(p);
      return store.has(np) || dirs.has(np);
    },

    readdirSync(p) {
      const np = normalize(p);
      if (!dirs.has(np)) {
        if (store.has(np)) throw fsError('ENOTDIR', 'scandir', np);
        throw fsError('ENOENT', 'scandir', np);
      }
      const names = new Set();
      const collect = (k) => {
        if (k !== np && dirname(k) === np) names.add(basename(k, np));
      };
      for (const k of store.keys()) collect(k);
      for (const d of dirs) collect(d);
      return [...names];
    },

    unlinkSync(p) {
      const np = normalize(p);
      if (!store.has(np)) throw fsError('ENOENT', 'unlink', np);
      store.delete(np);
      record('unlinkSync', [np]);
    },

    rmSync(p, opts = {}) {
      const np = normalize(p);
      const isFile = store.has(np);
      const isDir = dirs.has(np);
      if (!isFile && !isDir) {
        if (opts.force) return;
        throw fsError('ENOENT', 'rm', np);
      }
      if (isFile) store.delete(np);
      if (isDir) {
        const pre = np + '/';
        if (!opts.recursive) {
          const hasChildren = [...store.keys(), ...dirs].some((k) => k !== np && k.startsWith(pre));
          if (hasChildren) throw fsError('ENOTEMPTY', 'rmdir', np);
          dirs.delete(np);
        } else {
          for (const k of [...store.keys()]) if (k === np || k.startsWith(pre)) store.delete(k);
          for (const d of [...dirs]) if (d === np || d.startsWith(pre)) dirs.delete(d);
        }
      }
      record('rmSync', [np]);
    },

    statSync(p) {
      const np = normalize(p);
      if (store.has(np)) {
        const size = Buffer.byteLength(store.get(np));
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size, mtimeMs: mtimes.get(np) || 0 };
      }
      if (dirs.has(np)) {
        return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, size: 0, mtimeMs: mtimes.get(np) || 0 };
      }
      throw fsError('ENOENT', 'stat', np);
    },

    // The fake cannot represent symlinks, so lstat === stat and realpath is
    // normalization. Symlink-refusal behavior is proven over the real fs in
    // tests/integration/symlink-escape.test.mjs.
    lstatSync(p) {
      return fs.statSync(p);
    },

    realpathSync(p) {
      const np = normalize(p);
      if (!store.has(np) && !dirs.has(np)) throw fsError('ENOENT', 'realpath', np);
      return np;
    },

    copyFileSync(src, dest) {
      const ns = normalize(src);
      const nd = normalize(dest);
      if (!store.has(ns)) throw fsError('ENOENT', 'copyfile', ns);
      ensureParent(nd, 'copyfile');
      store.set(nd, store.get(ns));
      touch(nd);
      record('copyFileSync', [ns, nd]);
    },
  };

  // Introspection hook for atomicity assertions; not part of the real fs API.
  fs.__history = history;

  return { fs, files: () => snapshot() };
}
