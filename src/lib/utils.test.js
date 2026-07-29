import assert from 'node:assert/strict';
import test from 'node:test';

import { cn, safeJsonParse } from './utils.js';

test('cn merges class names and dedupes conflicting tailwind utilities', () => {
  assert.equal(cn('px-2', 'py-1'), 'px-2 py-1');
  // twMerge keeps the last conflicting utility.
  assert.equal(cn('px-2', 'px-4'), 'px-4');
});

test('cn resolves conditional and array inputs via clsx', () => {
  const off = false; // runtime-falsy so the conditional isn't a constant expression
  assert.equal(cn('a', off && 'b', ['c', null, undefined], { d: true, e: false }), 'a c d');
});

test('safeJsonParse parses valid JSON and returns null otherwise', () => {
  assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 });
  assert.deepEqual(safeJsonParse('[1,2]'), [1, 2]);
  assert.equal(safeJsonParse('not json'), null);
  assert.equal(safeJsonParse(''), null);
  assert.equal(safeJsonParse(null), null);
  assert.equal(safeJsonParse(42), null);
});
