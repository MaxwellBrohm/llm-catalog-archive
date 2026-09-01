/**
 * The git layer. Everything that touches the repository goes through here.
 *
 * History is the archive, so R7 applies to every function in this file: nothing
 * here rewrites, discards or force-writes a commit that already exists.
 */

import { spawnSync } from 'node:child_process';

export function git(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
}

/**
 * The newest commit instant touching `pathspec`, ISO 8601, or null.
 *
 * LIVES HERE BECAUSE src/git.ts IS THE ONLY MODULE ALLOWED TO START A PROCESS,
 * an invariant test/git.test.ts enforces by scanning every source file for a
 * child_process import. The liveness check needs exactly one git fact and the
 * first version of it imported execFileSync directly, which broke that
 * invariant and turned the whole suite red. Widening the guard would have been
 * the wrong repair: the point of a single spawning module is that the surface
 * which can run a command is one reviewed file, and a read-only query is not a
 * reason to make it two.
 *
 * A SHALLOW CHECKOUT LIES HERE. On a grafted clone this returns the graft point
 * rather than the real newest commit, which reads as a recent capture and
 * produces a false ALL CLEAR: the one answer the liveness check must never give
 * wrongly. The workflow that calls it checks out with fetch-depth 0.
 */
export function lastCommitInstant(cwd: string, pathspec: string): string | null {
  const r = git(['log', '-1', '--format=%cI', '--', pathspec], cwd);
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  return out === '' ? null : out;
}

/**
 * Stage exactly these paths and commit. Returns false when there was nothing
 * to commit, which is the ordinary no-change case and not an error.
 *
 * Paths are staged explicitly rather than with `git add -A`, because more than
 * one process can be working in a tree and sweeping up someone else's files is
 * how an unrelated change ships inside a collector commit.
 */
export function commitPaths(cwd: string, paths: string[], message: string): boolean {
  // Not a tidy early return. `git add --` with no pathspec adds nothing, but
  // `git commit -m msg --` with no pathspec commits whatever is ALREADY in the
  // index. Measured: with an unrelated file staged by another session, an empty
  // list walks straight past the staged-check below and ships that file in a
  // collector commit.
  if (paths.length === 0) return false;
  const add = git(['add', '--', ...paths], cwd);
  if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}`);

  const staged = git(['diff', '--cached', '--name-only', '--', ...paths], cwd);
  if (staged.stdout.trim() === '') return false;

  const c = git(['commit', '-q', '-m', message, '--', ...paths], cwd);
  if (c.status !== 0) throw new Error(`git commit failed: ${c.stderr}`);
  return true;
}

/**
 * Pull with rebase, then push. Never force.
 *
 * A rejected non-fast-forward push must not be resolved by force-pushing:
 * permalinks are commit shas and R7 makes them permanent.
 */
export function pushWithRebase(cwd: string, branch: string, attempts = 3): void {
  let lastErr = '';
  for (let i = 0; i < attempts; i++) {
    const pull = git(['pull', '--rebase', 'origin', branch], cwd);
    if (pull.status !== 0) {
      lastErr = pull.stderr;
      continue;
    }
    const push = git(['push', 'origin', branch], cwd);
    if (push.status === 0) return;
    lastErr = push.stderr;
  }
  throw new Error(`push failed after ${attempts} attempts: ${lastErr}`);
}
