import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeConversationResultPages } from '../utils';

const session = (sessionId: string, matchCount = 1) => ({
  sessionId,
  matches: Array.from({ length: matchCount }, (_, i) => ({ snippet: `${sessionId}-${i}` })),
});

const project = (projectName: string, sessions: ReturnType<typeof session>[]) => ({
  projectName,
  projectDisplayName: projectName,
  projectId: null,
  sessions,
});

test('appends sessions into an existing project bucket and new buckets at the end', () => {
  const first = { results: [project('/a', [session('s1', 2)]), project('/b', [session('s2')])], totalMatches: 3, query: 'q' };
  const page = { results: [project('/a', [session('s3', 2)]), project('/c', [session('s4')])], totalMatches: 3, query: 'q' };

  const merged = mergeConversationResultPages(first, page);
  assert.deepEqual(merged.results.map((p) => p.projectName), ['/a', '/b', '/c']);
  assert.deepEqual(merged.results[0].sessions.map((s) => s.sessionId), ['s1', 's3']);
  assert.equal(merged.totalMatches, 6);
  assert.equal(merged.query, 'q');
});

test('ignores sessions already shown and does not mutate inputs', () => {
  const first = { results: [project('/a', [session('s1')])], totalMatches: 1, query: 'q' };
  const page = { results: [project('/a', [session('s1'), session('s2')])], totalMatches: 2, query: 'q' };
  const snapshot = JSON.stringify(first);

  const merged = mergeConversationResultPages(first, page);
  assert.deepEqual(merged.results[0].sessions.map((s) => s.sessionId), ['s1', 's2']);
  assert.equal(merged.totalMatches, 2);
  assert.equal(JSON.stringify(first), snapshot);
});

test('empty page is a no-op', () => {
  const first = { results: [project('/a', [session('s1')])], totalMatches: 1, query: 'q' };
  const merged = mergeConversationResultPages(first, { results: [], totalMatches: 0, query: 'q' });
  assert.deepEqual(merged, first);
});
