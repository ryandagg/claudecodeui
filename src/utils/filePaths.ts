// Shared helpers for the handful of places that massage file references the way
// Claude emits them in chat — a path optionally tailed by a `:line` / `:line:col`
// position, sometimes with Windows backslashes. Previously each caller re-rolled
// these regexes (the chat link classifier, the editor open handler in
// MainContent, and the file-tree resolver), which is how they drifted apart.
// Defining them once keeps "what counts as a line suffix / a path separator"
// consistent across the in-chat file links and the Files side panel.

const LINE_SUFFIX_REGEX = /:(\d+)(?::(\d+))?$/;

export type FileRefLocation = {
  // The reference with any trailing `:line[:col]` removed.
  path: string;
  // 1-based line / column when the reference carried them.
  line?: number;
  column?: number;
};

// Split a reference like `server/index.js:42:7` into its path and position.
// References without a trailing numeric suffix come back unchanged with no line.
export const splitLineSuffix = (value: string): FileRefLocation => {
  const match = LINE_SUFFIX_REGEX.exec(value);
  if (!match) {
    return { path: value };
  }
  return {
    path: value.slice(0, match.index),
    line: Number(match[1]),
    column: match[2] !== undefined ? Number(match[2]) : undefined,
  };
};

// Just the path portion, dropping any `:line[:col]` suffix.
export const stripLineSuffix = (value: string): string => splitLineSuffix(value).path;

// Normalize Windows-style backslash separators to forward slashes so a single
// matching strategy works regardless of which OS produced the path.
export const normalizePathSeparators = (value: string): string => value.replace(/\\/g, '/');
