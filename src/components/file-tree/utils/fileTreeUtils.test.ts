import assert from 'node:assert/strict';
import test from 'node:test';

import type { FileTreeNode } from '../types/types';

import {
  collectExpandedDirectoryPaths,
  filterFileTree,
  formatFileSize,
  formatRelativeTime,
  isImageFile,
} from './fileTreeUtils';

const dir = (name: string, path: string, children: FileTreeNode[]): FileTreeNode => ({
  name,
  path,
  type: 'directory',
  children,
}) as FileTreeNode;

const file = (name: string, path: string): FileTreeNode => ({
  name,
  path,
  type: 'file',
}) as FileTreeNode;

const tree: FileTreeNode[] = [
  dir('src', '/src', [
    file('index.ts', '/src/index.ts'),
    dir('utils', '/src/utils', [file('math.ts', '/src/utils/math.ts')]),
  ]),
  file('README.md', '/README.md'),
];

// ---------------------------------------------------------------------------
// filterFileTree
// ---------------------------------------------------------------------------
test('filterFileTree keeps files matching the query', () => {
  const filtered = filterFileTree(tree, 'readme');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].name, 'README.md');
});

test('filterFileTree keeps a directory when a descendant matches', () => {
  const filtered = filterFileTree(tree, 'math');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].name, 'src');
  // Only the matching branch is retained.
  assert.equal(filtered[0].children?.[0].name, 'utils');
  assert.equal(filtered[0].children?.[0].children?.[0].name, 'math.ts');
});

test('filterFileTree returns [] when nothing matches', () => {
  assert.deepEqual(filterFileTree(tree, 'zzz'), []);
});

// ---------------------------------------------------------------------------
// collectExpandedDirectoryPaths
// ---------------------------------------------------------------------------
test('collectExpandedDirectoryPaths lists every non-empty directory path', () => {
  assert.deepEqual(collectExpandedDirectoryPaths(tree), ['/src', '/src/utils']);
});

test('collectExpandedDirectoryPaths ignores empty directories and files', () => {
  const withEmpty: FileTreeNode[] = [dir('empty', '/empty', []), file('a.ts', '/a.ts')];
  assert.deepEqual(collectExpandedDirectoryPaths(withEmpty), []);
});

// ---------------------------------------------------------------------------
// formatFileSize
// ---------------------------------------------------------------------------
test('formatFileSize renders human-readable sizes and trims trailing .0', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(undefined), '0 B');
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(1024), '1 KB');
  assert.equal(formatFileSize(1536), '1.5 KB');
  assert.equal(formatFileSize(1048576), '1 MB');
});

// ---------------------------------------------------------------------------
// formatRelativeTime
// ---------------------------------------------------------------------------
test('formatRelativeTime returns a dash for a missing date', () => {
  const t = ((key: string) => key) as never;
  assert.equal(formatRelativeTime(undefined, t), '-');
});

test('formatRelativeTime buckets recent timestamps into i18n keys', () => {
  // The `t` stub echoes the key (+count) so buckets are observable without a catalog.
  const t = ((key: string, opts?: { count?: number }) =>
    opts && typeof opts.count === 'number' ? `${key}:${opts.count}` : key) as never;
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  assert.equal(formatRelativeTime(iso(30 * 1000), t), 'fileTree.justNow');
  assert.equal(formatRelativeTime(iso(5 * 60 * 1000), t), 'fileTree.minAgo:5');
  assert.equal(formatRelativeTime(iso(3 * 60 * 60 * 1000), t), 'fileTree.hoursAgo:3');
  assert.equal(formatRelativeTime(iso(2 * 24 * 60 * 60 * 1000), t), 'fileTree.daysAgo:2');
});

test('formatRelativeTime falls back to a locale date beyond ~30 days', () => {
  const t = ((key: string) => key) as never;
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const result = formatRelativeTime(old, t);
  assert.equal(result.startsWith('fileTree.'), false);
  assert.ok(result.length > 0);
});

// ---------------------------------------------------------------------------
// isImageFile
// ---------------------------------------------------------------------------
test('isImageFile detects image extensions case-insensitively', () => {
  assert.equal(isImageFile('photo.PNG'), true);
  assert.equal(isImageFile('a.jpeg'), true);
  assert.equal(isImageFile('notes.txt'), false);
  assert.equal(isImageFile('Makefile'), false);
});
