import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateDiff, createCachedDiffCalculator } from './messageTransforms';

test('calculateDiff reports no diff lines for identical text', () => {
  assert.deepEqual(calculateDiff('a\nb\nc', 'a\nb\nc'), []);
});

test('calculateDiff records a single-line replacement as removed + added', () => {
  const diff = calculateDiff('a\nb\nc', 'a\nB\nc');
  assert.deepEqual(diff, [
    { type: 'removed', content: 'b', lineNum: 2 },
    { type: 'added', content: 'B', lineNum: 2 },
  ]);
});

test('calculateDiff isolates a pure insertion via LCS alignment', () => {
  // Inserting a line should not cascade the rest of the file into changes.
  const diff = calculateDiff('a\nc', 'a\nb\nc');
  assert.deepEqual(diff, [{ type: 'added', content: 'b', lineNum: 2 }]);
});

test('calculateDiff isolates a pure deletion', () => {
  const diff = calculateDiff('a\nb\nc', 'a\nc');
  assert.deepEqual(diff, [{ type: 'removed', content: 'b', lineNum: 2 }]);
});

test('createCachedDiffCalculator returns a cached result for repeat inputs', () => {
  const calc = createCachedDiffCalculator();
  const first = calc('a\nb', 'a\nB');
  const second = calc('a\nb', 'a\nB');
  // Same reference proves the memoized entry was reused.
  assert.equal(first, second);
  assert.deepEqual(second, [
    { type: 'removed', content: 'b', lineNum: 2 },
    { type: 'added', content: 'B', lineNum: 2 },
  ]);
});
