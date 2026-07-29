import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFrontMatter } from '@/shared/frontmatter.js';

test('parseFrontMatter reads YAML front matter into data and body', () => {
  const parsed = parseFrontMatter('---\nname: demo\ncount: 3\n---\n\nHello body.\n');
  assert.equal(parsed.data.name, 'demo');
  assert.equal(parsed.data.count, 3);
  assert.equal(parsed.content.trim(), 'Hello body.');
});

test('parseFrontMatter returns empty data for content without front matter', () => {
  const parsed = parseFrontMatter('no front matter here');
  assert.deepEqual(parsed.data, {});
  assert.equal(parsed.content, 'no front matter here');
});

test('parseFrontMatter does not execute JS-engine front matter (security)', () => {
  // A ```js``` fenced front matter block must NOT be evaluated — the engine is
  // stubbed to return {} so no executable project content ever runs.
  const parsed = parseFrontMatter('---js\nmodule.exports = { hacked: true }\n---\n\nbody\n');
  assert.deepEqual(parsed.data, {});
  assert.equal(parsed.content.trim(), 'body');
});
