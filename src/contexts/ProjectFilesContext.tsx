import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { api } from '../utils/api';
import { findBestMatch, flattenFileTree, type FlatFile } from '../utils/fileRefMatch';

type ProjectFiles = {
  // Resolve a (possibly bare/partial) reference to a real project file path, or
  // null when the project tree has no match — or has not loaded yet, so callers
  // err toward "not a file" until the ground truth is available.
  resolveFileRef: (ref: string) => string | null;
  // Whether the project file list has finished loading.
  isReady: boolean;
};

const DEFAULT: ProjectFiles = { resolveFileRef: () => null, isReady: false };

const ProjectFilesContext = createContext<ProjectFiles>(DEFAULT);

// Loads the current project's file list once (per project) and exposes a
// synchronous resolver so the chat markdown renderer can decide whether a
// path-shaped token is a real file before rendering it as a clickable link.
export function ProjectFilesProvider({
  projectId,
  children,
}: {
  projectId?: string;
  children: ReactNode;
}) {
  const [files, setFiles] = useState<FlatFile[] | null>(null);

  useEffect(() => {
    setFiles(null);
    if (!projectId) {
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await api.getFiles(projectId);
        if (cancelled) return;
        if (!response.ok) {
          setFiles([]);
          return;
        }
        const data = await response.json();
        if (cancelled) return;
        setFiles(flattenFileTree(Array.isArray(data) ? data : []));
      } catch {
        // A failed load settles as "no matches" rather than pending forever:
        // path-shaped refs simply stay plain text instead of linking to 404s.
        if (!cancelled) setFiles([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const value = useMemo<ProjectFiles>(
    () => ({
      resolveFileRef: (ref: string) => (files ? findBestMatch(files, ref) : null),
      isReady: files !== null,
    }),
    [files],
  );

  return <ProjectFilesContext.Provider value={value}>{children}</ProjectFilesContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useProjectFiles(): ProjectFiles {
  return useContext(ProjectFilesContext);
}
