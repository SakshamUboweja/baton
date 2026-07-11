import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { cmdDetect } from './commands/detect.mjs';
import { cmdRemap } from './commands/remap.mjs';

const COMMANDS = [
  'checkpoint',
  'finalize',
  'detect',
  'remap',
  'receive',
  'init',
  'doctor',
  'status',
  'purge-transcript',
  'recover',
];

function version() {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
  return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
}

const USAGE = `usage: baton <command> [options]

commands:
  ${COMMANDS.join(', ')}

global options:
  --version   print version
  --json      machine-readable output: one compact JSON envelope on stdout
`;

/**
 * The --json contract: exactly one compact envelope line on stdout, nothing else.
 * @param {any} io
 * @param {{ok: boolean, data?: any, warnings?: any[], error?: {code: string, msg: string} | null}} env
 */
function emitEnvelope(io, env) {
  const full = { ok: env.ok, data: env.data ?? null, warnings: env.warnings ?? [], error: env.error ?? null };
  io.stdout.write(JSON.stringify(full) + '\n');
}

/**
 * Minimal status: reports the active bundle if one exists at <cwd>/.handoff.
 * Bundle inspection deepens when the store module lands.
 * @param {string[]} args @param {any} io
 */
function cmdStatus(args, io) {
  const json = args.includes('--json');
  const bundlePath = join(io.cwd, '.handoff', 'bundle.json');
  if (!existsSync(bundlePath)) {
    const error = { code: 'no-bundle', msg: `no handoff bundle at ${bundlePath}; run 'baton init' or let checkpoints create one` };
    if (json) emitEnvelope(io, { ok: false, error });
    else io.stderr.write(`baton status: ${error.msg}\n`);
    return 1;
  }
  const raw = readFileSync(bundlePath, 'utf8');
  let bundle;
  try {
    bundle = JSON.parse(raw);
  } catch {
    const error = { code: 'corrupt-bundle', msg: `unparseable ${bundlePath}; recovery runs via 'baton checkpoint'` };
    if (json) emitEnvelope(io, { ok: false, error });
    else io.stderr.write(`baton status: ${error.msg}\n`);
    return 1;
  }
  const data = { bundleId: bundle.bundleId ?? null, status: bundle.handoff?.status ?? null, updatedAt: bundle.updatedAt ?? null };
  if (json) emitEnvelope(io, { ok: true, data });
  else io.stdout.write(`bundle ${data.bundleId ?? '?'} — ${data.status ?? '?'} — updated ${data.updatedAt ?? '?'}\n`);
  return 0;
}

/**
 * @param {string[]} argv process args after the binary
 * @param {any} io injected {cwd, stdout, stderr}
 * @returns {number} exit code
 */
export function run(argv, io) {
  const args = argv.filter((a) => a !== '');
  if (args.length === 0 || args[0] === '--help') {
    io.stdout.write(USAGE);
    return args.length === 0 ? 2 : 0;
  }
  if (args[0] === '--version') {
    io.stdout.write(version() + '\n');
    return 0;
  }

  const cmd = args[0];
  const rest = args.slice(1);

  if (cmd === 'wrap') {
    io.stderr.write(`baton wrap is reserved for a future release (PTY supervisor); not available in v1.\n${USAGE}`);
    return 2;
  }
  if (!COMMANDS.includes(cmd)) {
    io.stderr.write(`baton: unknown command '${cmd}'\n${USAGE}`);
    return 2;
  }

  if (rest.includes('--help')) {
    io.stdout.write(`usage: baton ${cmd} [options]\n\nSee README for the ${cmd} contract.\n`);
    return 0;
  }

  if (cmd === 'status') return cmdStatus(rest, io);
  if (cmd === 'detect') return cmdDetect(rest, io);
  if (cmd === 'remap') return cmdRemap(rest, io);

  const error = { code: 'not-implemented', msg: `baton ${cmd}: not implemented yet` };
  if (rest.includes('--json')) {
    emitEnvelope(io, { ok: false, error });
  } else {
    io.stderr.write(`${error.msg}\n`);
  }
  return 1;
}
