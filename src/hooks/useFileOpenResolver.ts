import { useCallback, useRef } from 'react';

import { api } from '../utils/api';
import { normalizePathSeparators } from '../utils/filePaths';
import { findBestMatch, flattenFileTree, type FlatFile } from '../utils/fileRefMatch';
import type { Project } from '../types/app';

// `diffInfo` is intentionally `any` so this resolver can wrap editor handlers
// that expect a concrete diff payload type as well as generic callers.
type OnFileOpen = (filePath: string, diffInfo?: any) => void;

/**
 * Wraps an `onFileOpen` handler so a possibly bare/partial file reference is
 * resolved against the project's file tree (cached per project) before the file
 * is opened in the in-app editor.
 */
export function useFileOpenResolver(
  selectedProject: Project | null | undefined,
  onFileOpen: OnFileOpen,
): OnFileOpen {
  const projectId = selectedProject?.projectId;
  const cacheRef = useRef<{ projectId?: string; files: Promise<FlatFile[]> | null }>({
    projectId: undefined,
    files: null,
  });

  const loadFiles = useCallback((): Promise<FlatFile[]> => {
    if (!projectId) {
      return Promise.resolve([]);
    }
    if (cacheRef.current.projectId === projectId && cacheRef.current.files) {
      return cacheRef.current.files;
    }

    const filesPromise = (async () => {
      try {
        const response = await api.getFiles(projectId);
        if (!response.ok) {
          return [];
        }
        const data = await response.json();
        return flattenFileTree(Array.isArray(data) ? data : []);
      } catch {
        return [];
      }
    })();

    cacheRef.current = { projectId, files: filesPromise };
    return filesPromise;
  }, [projectId]);

  return useCallback(
    (filePath: string, diffInfo?: any) => {
      const ref = normalizePathSeparators(filePath).trim();
      void loadFiles().then((files) => {
        const match = findBestMatch(files, ref);
        onFileOpen(match ?? filePath, diffInfo);
      });
    },
    [loadFiles, onFileOpen],
  );
}
