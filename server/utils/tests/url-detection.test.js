import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractUrlsFromText,
  normalizeDetectedUrl,
  shouldAutoOpenUrlFromOutput,
  stripAnsiSequences,
} from '../url-detection.js';

// ---------------------------------------------------------------------------
// stripAnsiSequences
// ---------------------------------------------------------------------------
test('stripAnsiSequences removes color/escape codes but keeps text', () => {
  assert.equal(stripAnsiSequences('\x1B[31mred\x1B[0m'), 'red');
  assert.equal(stripAnsiSequences('plain'), 'plain');
  assert.equal(stripAnsiSequences(), '');
});

// ---------------------------------------------------------------------------
// normalizeDetectedUrl
// ---------------------------------------------------------------------------
test('normalizeDetectedUrl trims trailing punctuation and normalizes', () => {
  assert.equal(normalizeDetectedUrl('https://example.com/path).'), 'https://example.com/path');
  assert.equal(normalizeDetectedUrl('  https://example.com  '), 'https://example.com/');
});

test('normalizeDetectedUrl rejects non-http(s) protocols and junk', () => {
  assert.equal(normalizeDetectedUrl('ftp://example.com'), null);
  assert.equal(normalizeDetectedUrl('file:///etc/passwd'), null);
  assert.equal(normalizeDetectedUrl('not a url'), null);
  assert.equal(normalizeDetectedUrl(''), null);
  assert.equal(normalizeDetectedUrl(null), null);
  assert.equal(normalizeDetectedUrl(42), null);
});

// ---------------------------------------------------------------------------
// extractUrlsFromText
// ---------------------------------------------------------------------------
test('extractUrlsFromText finds direct http/https matches and dedupes', () => {
  const urls = extractUrlsFromText('go to https://a.com and https://a.com and http://b.org');
  assert.deepEqual(urls.sort(), ['http://b.org', 'https://a.com']);
});

test('extractUrlsFromText reassembles a URL wrapped across terminal lines', () => {
  const text = 'Open this url:\nhttps://example.com/very/long/\npath/that-wrapped\nSome other line';
  const urls = extractUrlsFromText(text);
  assert.ok(urls.some((u) => u === 'https://example.com/very/long/path/that-wrapped'));
});

test('extractUrlsFromText returns [] when no URL present', () => {
  assert.deepEqual(extractUrlsFromText('no links here'), []);
  assert.deepEqual(extractUrlsFromText(), []);
});

// ---------------------------------------------------------------------------
// shouldAutoOpenUrlFromOutput
// ---------------------------------------------------------------------------
test('shouldAutoOpenUrlFromOutput matches known auth prompts case-insensitively', () => {
  assert.equal(shouldAutoOpenUrlFromOutput("Your browser didn't open automatically"), true);
  assert.equal(shouldAutoOpenUrlFromOutput('Please OPEN THIS URL to continue'), true);
  assert.equal(shouldAutoOpenUrlFromOutput('continue in your browser'), true);
  assert.equal(shouldAutoOpenUrlFromOutput('press enter to open'), true);
  assert.equal(shouldAutoOpenUrlFromOutput('open_url: https://x.com'), true);
});

test('shouldAutoOpenUrlFromOutput returns false for unrelated output', () => {
  assert.equal(shouldAutoOpenUrlFromOutput('just some log output'), false);
  assert.equal(shouldAutoOpenUrlFromOutput(), false);
});
