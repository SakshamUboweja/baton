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
