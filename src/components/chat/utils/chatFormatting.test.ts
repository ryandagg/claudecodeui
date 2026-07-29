import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeHtmlEntities,
  escapeRegExp,
  formatUsageLimitText,
  normalizeInlineCodeFences,
  unescapeWithMathProtection,
} from './chatFormatting';

// ---------------------------------------------------------------------------
// decodeHtmlEntities
// ---------------------------------------------------------------------------
test('decodeHtmlEntities decodes the common entities', () => {
  assert.equal(decodeHtmlEntities('&lt;div&gt; &amp; &quot;x&quot; &#39;y&#39;'), `<div> & "x" 'y'`);
  assert.equal(decodeHtmlEntities(''), '');
});

// ---------------------------------------------------------------------------
// normalizeInlineCodeFences
// ---------------------------------------------------------------------------
test('normalizeInlineCodeFences downgrades single-line triple fences to inline code', () => {
  assert.equal(normalizeInlineCodeFences('use ```npm run dev``` now'), 'use `npm run dev` now');
});

test('normalizeInlineCodeFences leaves multi-line code blocks alone', () => {
  const block = '```\nline1\nline2\n```';
  assert.equal(normalizeInlineCodeFences(block), block);
});

// ---------------------------------------------------------------------------
// unescapeWithMathProtection
// ---------------------------------------------------------------------------
test('unescapeWithMathProtection converts escape sequences outside math', () => {
  assert.equal(unescapeWithMathProtection('a\\nb\\tc'), 'a\nb\tc');
});

test('unescapeWithMathProtection preserves escapes inside $...$ and $$...$$ math', () => {
  // The \n inside the math block must survive verbatim.
  const input = 'before $a\\nb$ after $$c\\nd$$ end';
  const result = unescapeWithMathProtection(input);
  assert.ok(result.includes('$a\\nb$'));
  assert.ok(result.includes('$$c\\nd$$'));
  assert.ok(result.startsWith('before '));
});

// ---------------------------------------------------------------------------
// escapeRegExp
// ---------------------------------------------------------------------------
test('escapeRegExp escapes regex metacharacters', () => {
  assert.equal(escapeRegExp('a.b*c(d)'), 'a\\.b\\*c\\(d\\)');
  // The escaped output matches the literal string.
  assert.ok(new RegExp(escapeRegExp('a.b')).test('a.b'));
  assert.equal(new RegExp(escapeRegExp('a.b')).test('axb'), false);
});

// ---------------------------------------------------------------------------
// formatUsageLimitText
// ---------------------------------------------------------------------------
test('formatUsageLimitText rewrites a usage-limit marker into a readable reset line', () => {
  const result = formatUsageLimitText('Claude AI usage limit reached|1600000000');
  assert.match(result, /Claude usage limit reached\. Your limit will reset at/);
  assert.match(result, /2020/); // 2020-09-13 epoch
});

test('formatUsageLimitText leaves unrelated text unchanged', () => {
  assert.equal(formatUsageLimitText('just a normal message'), 'just a normal message');
});
