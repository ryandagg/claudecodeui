import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inlineCodeLooksLikePath,
  looksLikeFilePath,
  looksLikeUrl,
  stripLineSuffix,
} from './linkClassification';

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
// looksLikeUrl — hyperlinks that must open in the browser, never VS Code
// ---------------------------------------------------------------------------
test('looksLikeUrl recognizes scheme://authority URLs', () => {
  assert.equal(looksLikeUrl('https://example.com'), true);
  assert.equal(looksLikeUrl('http://example.com/path/to/page'), true);
  assert.equal(looksLikeUrl('HTTPS://Example.com'), true); // case-insensitive
  assert.equal(looksLikeUrl('ftp://host/file.txt'), true);
});

test('looksLikeUrl recognizes slash-less schemes', () => {
  assert.equal(looksLikeUrl('mailto:person@example.com'), true);
  assert.equal(looksLikeUrl('tel:+15551234567'), true);
  assert.equal(looksLikeUrl('data:text/plain;base64,QUJD'), true);
});

test('looksLikeUrl recognizes www. hosts and # fragments', () => {
  assert.equal(looksLikeUrl('www.example.com'), true);
  assert.equal(looksLikeUrl('#section-heading'), true);
});

test('looksLikeUrl does NOT treat Windows drive paths as URLs', () => {
  // `C:\Users\me` begins with `letter:` but is a file path, not a scheme.
  assert.equal(looksLikeUrl('C:\\Users\\me\\file.ts'), false);
  assert.equal(looksLikeUrl('C:/Users/me/file.ts'), false);
});

test('looksLikeUrl does NOT treat file paths as URLs', () => {
  assert.equal(looksLikeUrl('src/foo.ts'), false);
  assert.equal(looksLikeUrl('/Users/me/project/file.ts'), false);
  assert.equal(looksLikeUrl('foo.ts'), false);
  assert.equal(looksLikeUrl(undefined), false);
  assert.equal(looksLikeUrl(''), false);
});

// ---------------------------------------------------------------------------
// looksLikeFilePath — the regression at the heart of the bug
// ---------------------------------------------------------------------------
test('looksLikeFilePath accepts real workspace paths', () => {
  assert.equal(looksLikeFilePath('src/foo.ts'), true);
  assert.equal(looksLikeFilePath('server/index.js:42'), true); // line suffix
  assert.equal(looksLikeFilePath('/Users/me/project/file.ts'), true);
  assert.equal(looksLikeFilePath('C:\\Users\\me\\file.ts'), true);
  assert.equal(looksLikeFilePath('README.md'), true); // extension, no separator
});

test('looksLikeFilePath rejects URLs (the bug: // is not a path separator)', () => {
  assert.equal(looksLikeFilePath('https://example.com'), false);
  assert.equal(looksLikeFilePath('https://example.com/path/to/page'), false);
  assert.equal(looksLikeFilePath('http://a.b/c.js'), false); // has slashes AND .js, still a URL
  assert.equal(looksLikeFilePath('www.example.com'), false);
  assert.equal(looksLikeFilePath('mailto:person@example.com'), false);
  assert.equal(looksLikeFilePath('#anchor'), false);
});

test('looksLikeFilePath rejects empty / whitespace input', () => {
  assert.equal(looksLikeFilePath(undefined), false);
  assert.equal(looksLikeFilePath(''), false);
  assert.equal(looksLikeFilePath('   '), false);
});

// ---------------------------------------------------------------------------
// inlineCodeLooksLikePath — backticked code that should become a file link
// ---------------------------------------------------------------------------
test('inlineCodeLooksLikePath linkifies path-like inline code', () => {
  assert.equal(inlineCodeLooksLikePath('src/foo.ts'), true);
  assert.equal(inlineCodeLooksLikePath('server/index.js:42'), true);
  assert.equal(inlineCodeLooksLikePath('C:\\Users\\me\\file.ts'), true);
});

test('inlineCodeLooksLikePath does NOT linkify a backticked URL (the bug)', () => {
  // `https://example.com` in backticks previously opened `vscode://file/https://...`.
  assert.equal(inlineCodeLooksLikePath('https://example.com'), false);
  assert.equal(inlineCodeLooksLikePath('https://example.com/path'), false);
});

test('inlineCodeLooksLikePath leaves prose-y identifiers and flags as plain code', () => {
  assert.equal(inlineCodeLooksLikePath('array.map'), false); // no separator
  assert.equal(inlineCodeLooksLikePath('Math.random'), false);
  assert.equal(inlineCodeLooksLikePath('--flag'), false);
  assert.equal(inlineCodeLooksLikePath('some phrase/with space'), false); // whitespace
});
