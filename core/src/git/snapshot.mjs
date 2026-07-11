import { createHash } from 'node:crypto';

// Git facts degrade to null rather than block a checkpoint: not-a-repo,
// missing binary, and timeouts are all expected environments (plan §Root
// discovery & degraded modes).
const GIT_TIMEOUT_MS = 5000;
// The untracked digest is bounded: beyond this many paths, entries fold in by
// name only, keeping prepare-time hashing cheap on huge untracked trees.
const UNTRACKED_CAP = 200;
// NUL separator: cannot occur in diffs, sizes, hex hashes, or file paths, so
// joined digest inputs cannot collide across field boundaries.
const SEP = String.fromCharCode(0);
const NEWLINE = String.fromCharCode(10);

const sha256 = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex');

/**
 * Capture the repo's git state plus a content-sensitive digest. The digest
 * covers the staged diff, unstaged diff, and a bounded untracked-files digest
 * (path + size + content hash) — NOT the HEAD sha, which the receive token
 * binds as its own input, so a HEAD-only move is distinguishable from a
 * content change.
 * @param {{execFile: Function, cwd: string, fs: any}} deps
 * @returns {Promise<{branch: string, headSha: string, dirty: boolean, dirtySummary: string[], contentDigest: string} | null>}
 */
export async function snapshot({ execFile, cwd, fs }) {
  const git = (/** @type {string[]} */ args) => execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS });
  let branch, head, status, staged, unstaged, untrackedList;
  try {
    [branch, head, status, staged, unstaged, untrackedList] = await Promise.all([
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
      git(['rev-parse', 'HEAD']),
      git(['status', '--porcelain']),
      git(['diff', '--cached']),
      git(['diff']),
      git(['ls-files', '--others', '--exclude-standard']),
    ]);
  } catch {
    return null;
  }

  const nonEmptyLines = (/** @type {string} */ s) => s.split(NEWLINE).filter((/** @type {string} */ l) => l !== '');
  const dirtySummary = nonEmptyLines(status.stdout);
  const untrackedPaths = nonEmptyLines(untrackedList.stdout);

  const untrackedEntries = untrackedPaths.map((rel, i) => {
    if (i >= UNTRACKED_CAP) return [rel, 'capped'].join(SEP);
    try {
      const content = fs.readFileSync(cwd + '/' + rel, 'utf8');
      return [rel, String(Buffer.byteLength(content)), sha256(content)].join(SEP);
    } catch {
      // Listed but unreadable (deleted mid-flight): still digest its presence.
      return [rel, 'absent'].join(SEP);
    }
  });

  return {
    branch: branch.stdout.trim(),
    headSha: head.stdout.trim(),
    dirty: dirtySummary.length > 0,
    dirtySummary,
    contentDigest: sha256([staged.stdout, unstaged.stdout, ...untrackedEntries].join(SEP)),
  };
}
