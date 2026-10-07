import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isAbsoluteFileRef,
  normalizePathSeparators,
  splitLineSuffix,
  stripLineSuffix,
} from './filePaths';

// ---------------------------------------------------------------------------
// splitLineSuffix
// ---------------------------------------------------------------------------
test('splitLineSuffix extracts line and column', () => {
  assert.deepEqual(splitLineSuffix('server/index.js:42'), {
    path: 'server/index.js',
    line: 42,
    column: undefined,
  });
  assert.deepEqual(splitLineSuffix('src/foo.ts:130:12'), {
    path: 'src/foo.ts',
    line: 130,
    column: 12,
  });
});

test('splitLineSuffix returns the path unchanged when there is no suffix', () => {
  assert.deepEqual(splitLineSuffix('src/foo.ts'), { path: 'src/foo.ts' });
  assert.deepEqual(splitLineSuffix('README.md'), { path: 'README.md' });
});

test('splitLineSuffix does not treat a Windows drive letter as a suffix', () => {
  assert.deepEqual(splitLineSuffix('C:\\Users\\me\\file.ts'), { path: 'C:\\Users\\me\\file.ts' });
});

// ---------------------------------------------------------------------------
// stripLineSuffix
// ---------------------------------------------------------------------------
test('stripLineSuffix removes :line and :line:col suffixes', () => {
  assert.equal(stripLineSuffix('src/foo.ts:130'), 'src/foo.ts');
  assert.equal(stripLineSuffix('src/foo.ts:130:12'), 'src/foo.ts');
});

test('stripLineSuffix leaves paths without a numeric suffix untouched', () => {
  assert.equal(stripLineSuffix('src/foo.ts'), 'src/foo.ts');
  assert.equal(stripLineSuffix('README.md'), 'README.md');
});

// ---------------------------------------------------------------------------
// normalizePathSeparators
// ---------------------------------------------------------------------------
test('normalizePathSeparators converts backslashes to forward slashes', () => {
  assert.equal(normalizePathSeparators('C:\\Users\\me\\file.ts'), 'C:/Users/me/file.ts');
  assert.equal(normalizePathSeparators('src/foo.ts'), 'src/foo.ts');
});

// ---------------------------------------------------------------------------
// isAbsoluteFileRef
// ---------------------------------------------------------------------------
test('isAbsoluteFileRef recognizes POSIX, home, and Windows-drive references', () => {
  assert.equal(isAbsoluteFileRef('/Users/me/file.ts'), true);
  assert.equal(isAbsoluteFileRef('~'), true);
  assert.equal(isAbsoluteFileRef('~/notes.md'), true);
  assert.equal(isAbsoluteFileRef('C:\\Users\\me\\file.ts'), true);
  assert.equal(isAbsoluteFileRef('C:/Users/me/file.ts'), true);
});

test('isAbsoluteFileRef rejects relative paths and non-file slugs', () => {
  assert.equal(isAbsoluteFileRef('src/foo.ts'), false);
  assert.equal(isAbsoluteFileRef('heroku/api#18258'), false);
  assert.equal(isAbsoluteFileRef('jab/core-compute-hacks'), false);
  assert.equal(isAbsoluteFileRef('~nothome'), false);
});
