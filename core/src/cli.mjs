import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { cmdDetect } from './commands/detect.mjs';
import { cmdRemap } from './commands/remap.mjs';
import { cmdCheckpoint } from './commands/checkpoint.mjs';
import { cmdFinalize } from './commands/finalize.mjs';
import { cmdReceive } from './commands/receive.mjs';
import { cmdInit } from './commands/init.mjs';
import { cmdDoctor } from './commands/doctor.mjs';
import { cmdPurgeTranscript } from './commands/purge-transcript.mjs';
import { cmdSessionStart } from './commands/session-start.mjs';
import { cmdRecover } from './commands/recover.mjs';
import { cmdStatus } from './commands/status.mjs';
import { cmdLoop } from './commands/loop.mjs';

// The ten user-facing commands are the frozen v1 contract; session-start is an
// adapter-facing addition prescribed by gate-2 finding 8 (the cheap
// SessionStart gate Codex/Cursor hooks call — always exit 0).
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
  'session-start',
  // Layer 2 (goal loop) — added by the Gate-1-approved milestone-B plan.
  'loop',
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
 * @param {string[]} argv process args after the binary
 * @param {any} io injected {cwd, stdout, stderr}
 * @returns {number | Promise<number>} exit code
 */
export function run(argv, io) {
  const args = argv.filter((a) => a !== '');
  // Global --json intent is parsed BEFORE dispatch (gate-2 iter-2 M6): a
  // top-level `--json` with no command, or --help/--version, must still emit
  // exactly one envelope rather than raw text.
  const jsonWanted = args.includes('--json');
  const cmdIndex = args.findIndex((a) => !a.startsWith('--'));
  const cmd = cmdIndex === -1 ? undefined : args[cmdIndex];

  if (cmd === undefined) {
    // No command — just flags (or nothing).
    if (args.includes('--version')) {
      if (jsonWanted) emitEnvelope(io, { ok: true, data: { version: version() } });
      else io.stdout.write(version() + '\n');
      return 0;
    }
    if (args.includes('--help')) {
      if (jsonWanted) emitEnvelope(io, { ok: true, data: { usage: USAGE.trim() } });
      else io.stdout.write(USAGE);
      return 0;
    }
    // Bare invocation (or a lone --json): a usage error.
    if (jsonWanted) emitEnvelope(io, { ok: false, error: { code: 'usage', msg: 'no command given' } });
    else io.stdout.write(USAGE);
    return 2;
  }

  // All flags (before and after the command token) reach the command; only the
  // command token itself is stripped, so a leading `--json` isn't lost.
  const rest = args.filter((_, i) => i !== cmdIndex);

  // Usage errors honor the --json envelope contract too (gate-2 fix 11 + M6:
  // global --json counts, wherever it sits).
  const wantsJson = jsonWanted;
  if (cmd === 'wrap') {
    if (wantsJson) emitEnvelope(io, { ok: false, error: { code: 'usage', msg: 'baton wrap is reserved for a future release (PTY supervisor); not available in v1' } });
    else io.stderr.write(`baton wrap is reserved for a future release (PTY supervisor); not available in v1.\n${USAGE}`);
    return 2;
  }
  if (!COMMANDS.includes(cmd)) {
    if (wantsJson) emitEnvelope(io, { ok: false, error: { code: 'usage', msg: `unknown command '${cmd}'` } });
    else io.stderr.write(`baton: unknown command '${cmd}'\n${USAGE}`);
    return 2;
  }

  if (rest.includes('--help')) {
    // Subcommand help honors the global --json envelope too (iter-3 F8): with
    // --json it must emit exactly one envelope, never raw usage text.
    const usage = `usage: baton ${cmd} [options]\n\nSee README for the ${cmd} contract.`;
    if (wantsJson) emitEnvelope(io, { ok: true, data: { usage } });
    else io.stdout.write(`${usage}\n`);
    return 0;
  }

  if (cmd === 'status') return cmdStatus(rest, io);
  if (cmd === 'detect') return cmdDetect(rest, io);
  if (cmd === 'remap') return cmdRemap(rest, io);
  if (cmd === 'checkpoint') return cmdCheckpoint(rest, io);
  if (cmd === 'finalize') return cmdFinalize(rest, io);
  if (cmd === 'receive') return cmdReceive(rest, io);
  if (cmd === 'init') return cmdInit(rest, io);
  if (cmd === 'doctor') return cmdDoctor(rest, io);
  if (cmd === 'purge-transcript') return cmdPurgeTranscript(rest, io);
  if (cmd === 'session-start') return cmdSessionStart(rest, io);
  if (cmd === 'recover') return cmdRecover(rest, io);
  if (cmd === 'loop') return cmdLoop(rest, io);

  const error = { code: 'not-implemented', msg: `baton ${cmd}: not implemented yet` };
  if (rest.includes('--json')) {
    emitEnvelope(io, { ok: false, error });
  } else {
    io.stderr.write(`${error.msg}\n`);
  }
  return 1;
}
