import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { AppError } from '@/shared/utils.js';

const execFileAsync = promisify(execFile);

/**
 * Options for creating a git worktree at session-start time. Mirrors what the
 * `claude --worktree [name]` CLI flag does (create a worktree + launch the
 * session inside it), but implemented for CloudCLI's SDK-based per-turn model
 * where no CLI flag exists to pass through.
 */
export type SessionWorktreeOptions = {
  /**
   * Branch/dir name for the worktree. Blank → an auto-generated name. The git
   * `worktree add <path>` command infers the new branch name from the path's
   * final segment, so this doubles as both directory and branch name.
   */
  name?: string;
  /**
   * Commit-ish the new worktree branches from. Blank → the repo's default
   * remote branch (`origin/<default>`), matching the SDK's "fresh" base ref.
   * Any non-empty value (a branch, tag, SHA, or `HEAD`) is passed through
   * verbatim so the caller can branch from current local state instead.
   */
  baseRef?: string;
};

export type CreateSessionWorktreeResult = {
  /** Absolute path to the created worktree — becomes the session's cwd. */
  worktreePath: string;
  /** The branch name git created for the worktree. */
  branch: string;
  /** The commit-ish the worktree was based on. */
  baseRef: string;
};

/**
 * Turns a free-form name into a filesystem/branch-safe segment. Falls back to a
 * generated name when the input is empty or reduces to nothing usable.
 */
function normalizeWorktreeName(rawName: string | undefined): string {
  const trimmed = (rawName ?? '').trim();
  const slug = trimmed
    .replace(/[^\w.\-/]+/g, '-') // keep word chars, dot, dash, slash; collapse the rest
    .replace(/\.{2,}/g, '.') // collapse `..` so a name can't traverse out of the repo root
    .replace(/^[-/.]+|[-/.]+$/g, '') // no leading/trailing separators or dots
    .replace(/-{2,}/g, '-');

  if (slug.length > 0) {
    return slug;
  }

  // No usable name: generate a stable, sortable one. Date is fine here (server
  // runtime, not a resumable workflow script).
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', '');
  return `session-${stamp}`;
}

/**
 * Runs `git` with an argument array (no shell → no injection) inside `cwd`.
 * Throws AppError with the git stderr surfaced so route handlers can relay a
 * meaningful message.
 */
async function runGit(
  args: string[],
  cwd: string,
  deps: SessionWorktreeDependencies,
): Promise<string> {
  try {
    const { stdout } = await deps.execGit(args, cwd);
    return stdout.trim();
  } catch (error) {
    const stderr =
      typeof (error as { stderr?: unknown }).stderr === 'string'
        ? ((error as { stderr: string }).stderr).trim()
        : '';
    const message = stderr || (error instanceof Error ? error.message : String(error));
    throw new AppError(`git ${args[0]} failed: ${message}`, {
      code: 'WORKTREE_GIT_FAILED',
      statusCode: 400,
      details: { args, cwd, stderr: stderr || undefined },
    });
  }
}

export type SessionWorktreeDependencies = {
  execGit: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
};

const defaultDependencies: SessionWorktreeDependencies = {
  execGit: (args, cwd) => execFileAsync('git', args, { cwd, maxBuffer: 1024 * 1024 }),
};

/**
 * Resolves the "fresh" base ref for a repo: the ref that `origin/HEAD` points
 * at (e.g. `origin/main`). Falls back to `HEAD` when the repo has no configured
 * origin default (a local-only repo), so a worktree can still be created.
 */
async function resolveDefaultBaseRef(
  sourceRepoPath: string,
  deps: SessionWorktreeDependencies,
): Promise<string> {
  try {
    // e.g. "refs/remotes/origin/main" → "origin/main"
    const symbolic = await runGit(
      ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
      sourceRepoPath,
      deps,
    );
    const match = symbolic.match(/refs\/remotes\/(.+)$/);
    if (match) {
      return match[1];
    }
  } catch {
    // origin/HEAD not set (local-only repo, or never fetched): fall through.
  }
  return 'HEAD';
}

/**
 * Creates a git worktree for a brand-new session so the session launches with
 * its cwd already inside an isolated worktree — the startup-time equivalent of
 * `claude --worktree`. The returned `worktreePath` is stored as the session's
 * `project_path`, so the existing cwd plumbing carries it into the SDK with no
 * further changes.
 *
 * @param sourceRepoPath The git repo the session was started from.
 * @param options        Name + base ref (see SessionWorktreeOptions).
 * @throws AppError with code WORKTREE_NOT_GIT when the source isn't a git repo,
 *         or WORKTREE_GIT_FAILED when `git worktree add` fails.
 */
export async function createSessionWorktree(
  sourceRepoPath: string,
  options: SessionWorktreeOptions = {},
  deps: SessionWorktreeDependencies = defaultDependencies,
): Promise<CreateSessionWorktreeResult> {
  const trimmedRepo = sourceRepoPath.trim();
  if (!trimmedRepo) {
    throw new AppError('A project path is required to create a worktree.', {
      code: 'WORKTREE_SOURCE_REQUIRED',
      statusCode: 400,
    });
  }

  // Confirm the source is the top level of a git working tree. `git worktree`
  // must run from inside a repo; failing here (rather than letting `add` fail)
  // gives a precise, honest error.
  let repoTopLevel: string;
  try {
    repoTopLevel = await runGit(['rev-parse', '--show-toplevel'], trimmedRepo, deps);
  } catch {
    throw new AppError(
      `Not a git repository: ${trimmedRepo}. "Start in new worktree" requires the session's project to be a git repo.`,
      { code: 'WORKTREE_NOT_GIT', statusCode: 400 },
    );
  }

  const branch = normalizeWorktreeName(options.name);
  const baseRefInput = (options.baseRef ?? '').trim();
  const baseRef = baseRefInput || (await resolveDefaultBaseRef(repoTopLevel, deps));

  // Path mirrors `git worktree add <name>` run from the repo root: a sibling
  // directory of the repo's working files, named after the branch.
  const worktreePath = path.resolve(repoTopLevel, branch);

  // `git -C <repo> worktree add -b <branch> <path> <baseRef>` — create a new
  // branch off baseRef and check it out into the new worktree. `add` refuses to
  // clobber an existing path or reuse a live branch, so collisions fail loudly.
  await runGit(
    ['worktree', 'add', '-b', branch, worktreePath, baseRef],
    repoTopLevel,
    deps,
  );

  return { worktreePath, branch, baseRef };
}
