import assert from 'node:assert/strict';
import test from 'node:test';

import { getPreviewKind, getPreviewMimeType } from './previewableFile';
import { isBinaryFile } from './binaryFile';

// ---------------------------------------------------------------------------
// getPreviewKind / getPreviewMimeType
// ---------------------------------------------------------------------------
test('getPreviewKind classifies each previewable family', () => {
  assert.equal(getPreviewKind('logo.png'), 'image');
  assert.equal(getPreviewKind('scan.PDF'), 'pdf'); // case-insensitive
  assert.equal(getPreviewKind('clip.mp4'), 'video');
  assert.equal(getPreviewKind('track.mp3'), 'audio');
});

test('getPreviewKind returns null for non-previewable or extensionless files', () => {
  assert.equal(getPreviewKind('archive.zip'), null);
  assert.equal(getPreviewKind('movie.mkv'), null); // intentionally unsupported
  assert.equal(getPreviewKind('README'), null);
});

test('getPreviewMimeType returns the fallback MIME or undefined', () => {
  assert.equal(getPreviewMimeType('a.svg'), 'image/svg+xml');
  assert.equal(getPreviewMimeType('a.webm'), 'video/webm');
  assert.equal(getPreviewMimeType('a.zip'), undefined);
});

// ---------------------------------------------------------------------------
// isBinaryFile
// ---------------------------------------------------------------------------
test('isBinaryFile detects known binary extensions case-insensitively', () => {
  assert.equal(isBinaryFile('app.EXE'), true);
  assert.equal(isBinaryFile('data.sqlite3'), true);
  assert.equal(isBinaryFile('font.woff2'), true);
});

test('isBinaryFile returns false for text files and extensionless names', () => {
  assert.equal(isBinaryFile('index.ts'), false);
  assert.equal(isBinaryFile('notes.md'), false);
  assert.equal(isBinaryFile('Makefile'), false);
});
