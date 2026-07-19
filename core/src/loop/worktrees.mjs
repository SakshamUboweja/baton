/**
 * Guarded worktree transaction layer (Layer 3) — every git operation is a
 * checked transaction: namespaced branches only, pre/postflight assertions
 * around each child, merges under a supervisor merge lock gated on a
 * full-range attribution scan, ff-only seat syncs, prune self-heal, and a
 * branch jail so nothing outside baton/wt-* is ever touched. Plan:
 * docs/plans/2026-07-18-goal-loop-worktree-pipeline.md §"Worktree transaction
 * layer" + §"Attribution enforcement for child commits".
 */
import { ensureIgnoreLine } from '../scaffold/gitignore.mjs';
import { atomicWriteJson, ensureDir } from '../util/fsx.mjs';

export const WORKTREE_BRANCH_RE = /^baton\/wt-(a|b)\//;

const SEATS = /** @type {const} */ (['a', 'b']);
const SOLE_AUTHOR = { name: 'SakshamUboweja', email: 'ssakshamu@gmail.com' };

// Mirrors the doctor git-guard trailer discipline (core/src/commands/doctor.mjs).
const TRAILER_PATTERNS = [
  /co-authored-by:[^\n]*\b(claude|gpt|copilot|codex)\b/i,
  /generated (with|by)[^\n]*\bclaude\b/i,
  /\u{1F916}/u,
];

// One declared log format — per-commit fields NUL-delimited in this exact
// order (sha, author name/email, committer name/email, body), records
// RS-terminated. The parser below consumes exactly this shape.
const LOG_FORMAT = '%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e';

/** @param {string} root */
export function worktreePaths(root) {
  const dir = `${root}/.worktrees`;
  /** @type {Record<string, string>} */
  const seats = { a: `${dir}/wt-a`, b: `${dir}/wt-b` };
  return { dir, seats };
}

/** @param {string} seat */
const seatBranch = (seat) => `baton/wt-${seat}/base`;

/** @param {any} io @param {string} cwd @param {string[]} args */
async function git(io, cwd, args) {
  return io.execFile('git', args, { cwd });
}

/** Parse `git worktree list --porcelain` into [{path, branch}]. @param {string} out */
function parseWorktreeList(out) {
  /** @type {Array<{path: string, branch: string | null}>} */
  const entries = [];
  for (const block of String(out).split(/\n\n+/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path) continue;
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null;
    entries.push({ path, branch });
  }
  return entries;
}

/**
 * Ensure both seat worktrees exist on their namespaced branches and that
 * `.worktrees/` is gitignored. Idempotent: an existing seat is left alone.
 * @param {string} root @param {any} io
 * @returns {Promise<{ok: boolean, worktrees: Array<{seat: string, path: string, branch: string}>, gitignoreChanged: boolean}>}
 */
export async function setupWorktrees(root, io) {
  const p = worktreePaths(root);

  const gitignorePath = `${root}/.gitignore`;
  const existing = io.fs.existsSync(gitignorePath) ? io.fs.readFileSync(gitignorePath, 'utf8') : '';
  const ensured = ensureIgnoreLine(existing, '.worktrees/');
  if (ensured.changed) io.fs.writeFileSync(gitignorePath, ensured.text);

  const listed = parseWorktreeList((await git(io, root, ['worktree', 'list', '--porcelain'])).stdout);
  /** @type {Array<{seat: string, path: string, branch: string}>} */
  const worktrees = [];
  for (const seat of SEATS) {
    const path = p.seats[seat];
    const present = listed.find((e) => e.path === path);
    if (present) {
      worktrees.push({ seat, path, branch: present.branch ?? seatBranch(seat) });
      continue;
    }
    const branch = seatBranch(seat);
    await git(io, root, ['worktree', 'add', '-b', branch, path]);
    worktrees.push({ seat, path, branch });
  }
  return { ok: true, worktrees, gitignoreChanged: ensured.changed };
}

/**
 * Preflight before a child runs in a seat: the worktree is listed, its index
 * is clean, and HEAD sits on the expected branch. Refusals name the failed
 * check and never issue destructive git.
 * @param {string} root @param {{seat: string, branch: string}} target @param {any} io
 * @returns {Promise<{ok: true} | {ok: false, check: string, refusal: string}>}
 */
export async function preflightWorktree(root, target, io) {
  const path = worktreePaths(root).seats[target.seat];
  const listed = parseWorktreeList((await git(io, root, ['worktree', 'list', '--porcelain'])).stdout);
  if (!listed.some((e) => e.path === path)) {
    return { ok: false, check: 'missing-worktree', refusal: `worktree ${path} is not listed by git — run setup or self-heal first` };
  }
  const status = (await git(io, path, ['status', '--porcelain'])).stdout.trim();
  if (status.length > 0) {
    return { ok: false, check: 'dirty-index', refusal: `worktree ${path} has a dirty index/working tree — a clean seat is required before a child runs` };
  }
  const head = (await git(io, path, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  if (head !== target.branch) {
    return { ok: false, check: 'wrong-branch', refusal: `worktree ${path} HEAD is on '${head}', expected branch '${target.branch}'` };
  }
  return { ok: true };
}

/**
 * Postflight after a child: HEAD still on the expected branch (checked in the
 * seat cwd) and main unmoved from the pre-child capture.
 * @param {string} root @param {{seat: string, branch: string, mainSha: string}} target @param {any} io
 * @returns {Promise<{ok: true} | {ok: false, check: string, refusal: string}>}
 */
export async function postflightWorktree(root, target, io) {
  const path = worktreePaths(root).seats[target.seat];
  const head = (await git(io, path, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  if (head !== target.branch) {
    return { ok: false, check: 'head-drift', refusal: `the child left HEAD on '${head}' instead of the expected branch '${target.branch}'` };
  }
  const main = (await git(io, root, ['rev-parse', 'main'])).stdout.trim();
  if (main !== target.mainSha) {
    return { ok: false, check: 'main-moved', refusal: `main moved under the child (was ${target.mainSha}, now ${main}) — only the merger writes main` };
  }
  return { ok: true };
}

/**
 * Full-range attribution scan over main..branch — the merge gate. Every
 * commit must be authored AND committed by the sole author, with no forbidden
 * AI-attribution trailer in the body. The range is never windowed.
 * @param {string} root @param {string} branch @param {any} io
 * @returns {Promise<{ok: true} | {ok: false, offending: string, reason: string}>}
 */
export async function attributionScan(root, branch, io) {
  const out = (await git(io, root, ['log', `main..${branch}`, `--format=${LOG_FORMAT}`])).stdout;
  for (const record of String(out).split('\x1e')) {
    if (record.trim().length === 0) continue;
    const [sha, an, ae, cn, ce, body = ''] = record.replace(/^\n/, '').split('\x00');
    if (an !== SOLE_AUTHOR.name || ae !== SOLE_AUTHOR.email) {
      return { ok: false, offending: sha, reason: `commit ${sha} has a foreign author identity (${an} <${ae}>) — sole-author is required` };
    }
    if (cn !== SOLE_AUTHOR.name || ce !== SOLE_AUTHOR.email) {
      return { ok: false, offending: sha, reason: `commit ${sha} has a foreign committer identity (${cn} <${ce}>) — sole-author is required` };
    }
    if (TRAILER_PATTERNS.some((re) => re.test(body))) {
      return { ok: false, offending: sha, reason: `commit ${sha} carries a forbidden AI-attribution trailer (co-authored/generated-with/emoji) in its message` };
    }
  }
  return { ok: true };
}

const mergeLockPath = (/** @type {string} */ root) => `${root}/.handoff/loop/merge.lock`;

/**
 * Merge an approved subtask branch into main — one guarded transaction:
 * acquire the merge lock (a held lock refuses), gate on the attribution scan,
 * merge at the repo root, abort-and-park on conflict, then ff-only sync both
 * seats. The lock is released on EVERY exit path after acquisition.
 * @param {string} root @param {{branch: string}} input @param {any} io
 * @returns {Promise<{ok: true, branch: string} | {ok: false, reason: string}>}
 */
export async function mergeSubtask(root, input, io) {
  const lock = mergeLockPath(root);
  if (io.fs.existsSync(lock)) {
    return { ok: false, reason: `the merge lock at ${lock} is held by another merger — refusing a concurrent merge` };
  }
  ensureDir(io.fs, `${root}/.handoff/loop`);
  atomicWriteJson(io.fs, lock, { host: io.host, pid: io.pid, at: io.now() });
  try {
    const scan = await attributionScan(root, input.branch, io);
    if (scan.ok !== true) return { ok: false, reason: scan.reason };

    try {
      await git(io, root, ['merge', input.branch]);
    } catch (err) {
      // Conflict (or any merge failure): abort, never auto-resolve — park.
      try {
        await git(io, root, ['merge', '--abort']);
      } catch {
        // Nothing to abort — the failure predates a merge state.
      }
      const msg = /** @type {any} */ (err)?.stdout || /** @type {any} */ (err)?.message || String(err);
      return { ok: false, reason: `merge conflict — aborted and parked for the operator: ${String(msg).split('\n')[0]}` };
    }

    const seats = worktreePaths(root).seats;
    for (const seat of SEATS) {
      try {
        await git(io, seats[seat], ['merge', '--ff-only', 'main']);
      } catch (err) {
        const msg = /** @type {any} */ (err)?.stderr || /** @type {any} */ (err)?.message || String(err);
        return { ok: false, reason: `worktree wt-${seat} could not fast-forward to main — corruption signal, parked: ${String(msg).split('\n')[0]}` };
      }
    }
    return { ok: true, branch: input.branch };
  } finally {
    try {
      if (io.fs.existsSync(lock)) io.fs.unlinkSync(lock);
    } catch {
      // Best effort — a leaked lock is visible and operator-recoverable.
    }
  }
}

/**
 * Self-heal a raw-deleted seat: git still lists it but the directory is gone
 * — prune the stale metadata and re-add on the same branch.
 * @param {string} root @param {{seat: string, branch: string}} target @param {any} io
 * @returns {Promise<{ok: boolean, healed: boolean}>}
 */
export async function selfHealWorktree(root, target, io) {
  const path = worktreePaths(root).seats[target.seat];
  const listed = parseWorktreeList((await git(io, root, ['worktree', 'list', '--porcelain'])).stdout);
  const stale = listed.some((e) => e.path === path) && !io.fs.existsSync(path);
  if (!stale) return { ok: true, healed: false };
  await git(io, root, ['worktree', 'prune']);
  await git(io, root, ['worktree', 'add', path, target.branch]);
  return { ok: true, healed: true };
}

/**
 * Tear down BOTH seats: remove the worktrees and delete their namespaced
 * branches. Anything outside .worktrees/wt-* or baton/wt-* is never touched,
 * so a teardown leaves the repo a plain git repo (acceptance constraint 5).
 * @param {string} root @param {any} io
 * @returns {Promise<{ok: boolean, removed: string[]}>}
 */
export async function teardownWorktrees(root, io) {
  const p = worktreePaths(root);
  const listed = parseWorktreeList((await git(io, root, ['worktree', 'list', '--porcelain'])).stdout);
  /** @type {string[]} */
  const removed = [];
  for (const seat of SEATS) {
    const entry = listed.find((e) => e.path === p.seats[seat]);
    if (!entry) continue;
    await git(io, root, ['worktree', 'remove', '--force', p.seats[seat]]);
    if (entry.branch && WORKTREE_BRANCH_RE.test(entry.branch)) {
      await git(io, root, ['branch', '-D', entry.branch]);
    }
    removed.push(seat);
  }
  return { ok: true, removed };
}

/**
 * Branch jail: only baton/wt-* branches may ever be deleted through this
 * layer. An out-of-namespace ref refuses without touching git.
 * @param {string} root @param {string} branch @param {any} io
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function deleteBranch(root, branch, io) {
  if (!WORKTREE_BRANCH_RE.test(branch)) {
    return { ok: false, error: `refused: '${branch}' is outside the baton/wt- namespace — the loop never deletes non-loop branches` };
  }
  await git(io, root, ['branch', '-D', branch]);
  return { ok: true };
}
