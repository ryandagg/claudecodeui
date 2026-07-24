import { useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

type SessionRepoInfo = {
  /** Owning repository name (for a worktree, the originating repo). */
  repo: string | null;
  /** Current branch of the session's working directory. */
  branch: string | null;
  /** False when the session's cwd is not a git repository. */
  isGitRepo: boolean;
  /** True while the first fetch for the current project is in flight. */
  loading: boolean;
};

const EMPTY: SessionRepoInfo = { repo: null, branch: null, isGitRepo: false, loading: false };

/**
 * Read-only lookup of the repo + branch for a project's working directory,
 * used to show "<repo> · <branch>" in the session header. Reuses the existing
 * `/api/git/status` endpoint (which now also returns `repo`); a worktree
 * resolves `repo` to its originating repository, not the worktree dir.
 *
 * The request is keyed on `projectId` and guarded against races: a response
 * for a project the user has since navigated away from is discarded.
 */
export function useSessionRepoInfo(projectId: string | null | undefined): SessionRepoInfo {
  const [info, setInfo] = useState<SessionRepoInfo>(EMPTY);
  const requestedProjectRef = useRef<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      requestedProjectRef.current = null;
      setInfo(EMPTY);
      return undefined;
    }

    requestedProjectRef.current = projectId;
    const controller = new AbortController();
    setInfo((prev) => ({ ...prev, loading: true }));

    (async () => {
      try {
        const response = await authenticatedFetch(
          `/api/git/status?project=${encodeURIComponent(projectId)}`,
          { signal: controller.signal },
        );
        const data = await response.json();

        // Ignore a stale response for a project we've navigated away from.
        if (controller.signal.aborted || requestedProjectRef.current !== projectId) {
          return;
        }

        // `error` (e.g. not a git repository) → treat as "no git info", not a failure.
        if (data?.error || (!data?.repo && !data?.branch)) {
          setInfo({ repo: null, branch: null, isGitRepo: false, loading: false });
          return;
        }

        setInfo({
          repo: typeof data.repo === 'string' ? data.repo : null,
          branch: typeof data.branch === 'string' ? data.branch : null,
          isGitRepo: true,
          loading: false,
        });
      } catch {
        if (controller.signal.aborted || requestedProjectRef.current !== projectId) {
          return;
        }
        setInfo({ repo: null, branch: null, isGitRepo: false, loading: false });
      }
    })();

    return () => controller.abort();
  }, [projectId]);

  return info;
}
