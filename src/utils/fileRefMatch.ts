// Matches a file reference emitted in chat (a bare basename, a partial path, or
// a full path) against a project's actual file tree. This is the ground-truth
// counterpart to the shape heuristics in linkClassification: the heuristics can
// tell that `jab/core-compute-hacks` is *path-shaped*, but only the real tree
// knows it isn't a file (it's a git branch). The matching here is extracted so
// both the click-time opener (useFileOpenResolver) and the render-time link
// gating (ProjectFilesContext) agree on exactly what counts as a match.

import { isAbsoluteFileRef, normalizePathSeparators, stripLineSuffix } from './filePaths';

export type FileTreeNode = {
  type: 'file' | 'directory';
  name: string;
  path: string;
  children?: FileTreeNode[];
};

export type FlatFile = {
  name: string;
  path: string;
};

// Flatten a project file tree down to its files (directories are dropped).
export const flattenFileTree = (nodes: FileTreeNode[]): FlatFile[] => {
  const out: FlatFile[] = [];
  const visit = (list: FileTreeNode[]): void => {
    for (const node of list) {
      if (node.type === 'file') {
        out.push({ name: node.name, path: node.path });
      } else if (node.children && node.children.length > 0) {
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return out;
};

// References inside chat messages are often bare basenames (`foo.ts`) or partial
// paths (`utils/foo.ts`) rather than full paths, so match by path suffix and
// fall back to filename equality. Returns the real project path, or null when
// nothing in the tree matches.
export const findBestMatch = (files: FlatFile[], ref: string): string | null => {
  const target = normalizePathSeparators(ref).replace(/^\.\//, '').replace(/^\/+/, '');
  if (!target) {
    return null;
  }

  const suffixMatch = files.find((file) => {
    const filePath = normalizePathSeparators(file.path);
    return filePath === target || filePath.endsWith(`/${target}`);
  });
  if (suffixMatch) {
    return suffixMatch.path;
  }

  const base = target.split('/').pop() || target;
  return files.find((file) => file.name === base)?.path ?? null;
};

// Decides whether a path-shaped reference should actually be rendered as an
// openable file link. Absolute references (`/…`, `~/…`, `C:\…`) point at a
// concrete location and open as-is, so they stay clickable even when the
// project tree doesn't list them; everything else must resolve to a real file,
// which is what keeps `heroku/api#18258` and branch names like
// `jab/core-compute-hacks` from masquerading as files.
export const isOpenableFileRef = (
  ref: string,
  resolve: (candidate: string) => string | null,
): boolean => {
  const stripped = stripLineSuffix(ref.trim());
  if (!stripped) {
    return false;
  }
  return isAbsoluteFileRef(stripped) || resolve(stripped) !== null;
};
