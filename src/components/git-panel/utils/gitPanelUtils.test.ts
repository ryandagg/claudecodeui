import assert from 'node:assert/strict';
import test from 'node:test';

import type { GitStatusResponse } from '../types/types';

import {
  getAllChangedFiles,
  getChangedFileCount,
  getStatusBadgeClass,
  getStatusLabel,
  hasChangedFiles,
  parseCommitFiles,
} from './gitPanelUtils';

const status = (overrides: Partial<GitStatusResponse> = {}): GitStatusResponse => ({
  modified: [],
  added: [],
  deleted: [],
  untracked: [],
  ...overrides,
}) as GitStatusResponse;

// ---------------------------------------------------------------------------
// changed-file aggregation
// ---------------------------------------------------------------------------
test('getAllChangedFiles flattens all status groups', () => {
  const gitStatus = status({ modified: ['a.ts'], added: ['b.ts'], deleted: ['c.ts'], untracked: ['d.ts'] });
  assert.deepEqual(getAllChangedFiles(gitStatus), ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
});

test('getAllChangedFiles returns [] for null status', () => {
  assert.deepEqual(getAllChangedFiles(null), []);
});

test('getChangedFileCount and hasChangedFiles reflect totals', () => {
  const empty = status();
  assert.equal(getChangedFileCount(empty), 0);
  assert.equal(hasChangedFiles(empty), false);

  const dirty = status({ modified: ['a'], untracked: ['b', 'c'] });
  assert.equal(getChangedFileCount(dirty), 3);
  assert.equal(hasChangedFiles(dirty), true);
});

// ---------------------------------------------------------------------------
// status label/badge lookups
// ---------------------------------------------------------------------------
test('getStatusLabel maps known codes and echoes unknown ones', () => {
  assert.equal(getStatusLabel('M'), 'Modified');
  assert.equal(getStatusLabel('A'), 'Added');
  assert.equal(getStatusLabel('Z' as never), 'Z');
});

test('getStatusBadgeClass falls back to the untracked class for unknown codes', () => {
  assert.equal(getStatusBadgeClass('Z' as never), getStatusBadgeClass('U'));
});

// ---------------------------------------------------------------------------
// parseCommitFiles
// ---------------------------------------------------------------------------
test('parseCommitFiles extracts per-file status and line counts from git show', () => {
  const showOutput = [
    'commit abc123',
    'Author: Someone',
    '',
    'diff --git a/src/added.ts b/src/added.ts',
    'new file mode 100644',
    'index 000..111',
    '--- /dev/null',
    '+++ b/src/added.ts',
    '@@ -0,0 +1,2 @@',
    '+line one',
    '+line two',
    'diff --git a/src/edited.ts b/src/edited.ts',
    'index 222..333 100644',
    '--- a/src/edited.ts',
    '+++ b/src/edited.ts',
    '@@ -1,2 +1,2 @@',
    '-old line',
    '+new line',
    'diff --git a/removed.ts b/removed.ts',
    'deleted file mode 100644',
    'index 444..000',
    '--- a/removed.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
  ].join('\n');

  const summary = parseCommitFiles(showOutput);
  assert.equal(summary.totalFiles, 3);

  const added = summary.files.find((f) => f.path === 'src/added.ts');
  assert.equal(added?.status, 'A');
  assert.equal(added?.directory, 'src/');
  assert.equal(added?.filename, 'added.ts');
  assert.equal(added?.insertions, 2);
  assert.equal(added?.deletions, 0);

  const edited = summary.files.find((f) => f.path === 'src/edited.ts');
  assert.equal(edited?.status, 'M');
  assert.equal(edited?.insertions, 1);
  assert.equal(edited?.deletions, 1);

  const removed = summary.files.find((f) => f.path === 'removed.ts');
  assert.equal(removed?.status, 'D');
  assert.equal(removed?.directory, '');
  assert.equal(removed?.filename, 'removed.ts');

  assert.equal(summary.totalInsertions, 3);
  assert.equal(summary.totalDeletions, 2);
});

test('parseCommitFiles returns an empty summary for output with no diffs', () => {
  const summary = parseCommitFiles('commit abc\nAuthor: x\n\n    message only\n');
  assert.deepEqual(summary, { files: [], totalFiles: 0, totalInsertions: 0, totalDeletions: 0 });
});
