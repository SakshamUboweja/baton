/**
 * The --json contract: exactly one compact envelope line on stdout, nothing else.
 * @param {any} io
 * @param {{ok: boolean, data?: any, warnings?: any[], error?: {code: string, msg: string} | null}} env
 */
export function emitEnvelope(io, env) {
  const full = { ok: env.ok, data: env.data ?? null, warnings: env.warnings ?? [], error: env.error ?? null };
  io.stdout.write(JSON.stringify(full) + '\n');
}

/**
 * Repo-root discovery (plan §Root discovery): `--root` wins; else the nearest
 * ancestor of io.cwd carrying `.handoff/` or `baton.config.json`; else the
 * nearest ancestor carrying `.git` (the repo toplevel — and a boundary the
 * walk never crosses, so a nested repo resolves to itself); else io.cwd.
 * @param {any} io @param {Record<string, string | boolean>} flags
 * @returns {string}
 */
export function resolveRoot(io, flags) {
  if (typeof flags.root === 'string' && flags.root.length > 0) return flags.root;
  let dir = String(io.cwd);
  while (true) {
    try {
      if (io.fs.existsSync(`${dir}/.handoff`) || io.fs.existsSync(`${dir}/baton.config.json`)) return dir;
      if (io.fs.existsSync(`${dir}/.git`)) return dir; // repo toplevel; never walk past a .git boundary
    } catch {
      break;
    }
    const parent = dir.slice(0, dir.lastIndexOf('/')) || '/';
    if (parent === dir) break;
    dir = parent;
  }
  return String(io.cwd);
}

/**
 * Minimal flag parser: `--key value` pairs (value = next token not starting
 * with --), bare `--key` booleans, positionals collected in order.
 * @param {string[]} args
 * @returns {{flags: Record<string, string | boolean>, positionals: string[]}}
 */
export function parseFlags(args) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  /** @type {string[]} */
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}
