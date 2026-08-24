import assert from 'node:assert/strict';
import test from 'node:test';

import { getMermaidId, getMermaidInitConfig, getMermaidTheme, isMermaidCodeNode } from './mermaidConfig';

// ---------------------------------------------------------------------------
// getMermaidTheme
// ---------------------------------------------------------------------------
test('getMermaidTheme maps the app light/dark flag to a mermaid theme', () => {
  assert.equal(getMermaidTheme(true), 'dark');
  assert.equal(getMermaidTheme(false), 'default');
});

// ---------------------------------------------------------------------------
// getMermaidId
// ---------------------------------------------------------------------------
test('getMermaidId strips the colons React useId() produces', () => {
  // ":r7:" would break the CSS selectors mermaid derives from the id.
  assert.equal(getMermaidId(':r7:'), 'mermaid-r7');
  assert.ok(!getMermaidId(':r7:').includes(':'));
});

test('getMermaidId keeps safe identifier characters', () => {
  assert.equal(getMermaidId('abc_123-XYZ'), 'mermaid-abc_123-XYZ');
});

test('getMermaidId falls back to a stable id when the seed has no safe chars', () => {
  assert.equal(getMermaidId('::::'), 'mermaid-diagram');
  assert.equal(getMermaidId(''), 'mermaid-diagram');
});

test('getMermaidId produces a valid CSS identifier for arbitrary seeds', () => {
  const id = getMermaidId(':r1a: b/c.d');
  // A CSS ident must start with a letter/underscore/hyphen and contain no
  // whitespace or punctuation beyond hyphen/underscore.
  assert.match(id, /^[a-zA-Z_-][a-zA-Z0-9_-]*$/);
});

// ---------------------------------------------------------------------------
// getMermaidInitConfig
// ---------------------------------------------------------------------------
test('getMermaidInitConfig disables auto-start and pins strict security', () => {
  const config = getMermaidInitConfig(false);
  assert.equal(config.startOnLoad, false);
  assert.equal(config.securityLevel, 'strict');
  assert.equal(config.theme, 'default');
});

test('getMermaidInitConfig carries the dark theme when in dark mode', () => {
  assert.equal(getMermaidInitConfig(true).theme, 'dark');
});

// ---------------------------------------------------------------------------
// isMermaidCodeNode
// ---------------------------------------------------------------------------
const preNodeWith = (className: unknown) => ({
  children: [{ tagName: 'code', properties: { className } }],
});

test('isMermaidCodeNode detects a mermaid fenced block (className array)', () => {
  assert.equal(isMermaidCodeNode(preNodeWith(['language-mermaid'])), true);
});

test('isMermaidCodeNode detects a mermaid fenced block (className string)', () => {
  assert.equal(isMermaidCodeNode(preNodeWith('language-mermaid')), true);
});

test('isMermaidCodeNode is false for other languages and plain fences', () => {
  assert.equal(isMermaidCodeNode(preNodeWith(['language-js'])), false);
  assert.equal(isMermaidCodeNode(preNodeWith(undefined)), false);
});

test('isMermaidCodeNode is false when the first child is not a <code>', () => {
  assert.equal(isMermaidCodeNode({ children: [{ tagName: 'span', properties: {} }] }), false);
});

test('isMermaidCodeNode is false for malformed / empty nodes', () => {
  assert.equal(isMermaidCodeNode(undefined), false);
  assert.equal(isMermaidCodeNode(null), false);
  assert.equal(isMermaidCodeNode({}), false);
  assert.equal(isMermaidCodeNode({ children: [] }), false);
});
