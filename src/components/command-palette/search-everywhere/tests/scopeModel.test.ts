import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECENT_VIEWED_LIMIT,
  SCOPE_PRESETS,
  effectiveScope,
  isScopePreset,
  orderForScope,
  parseRecentlyViewed,
  parseScopeState,
  recordRecentlyViewed,
  sessionInScope,
  widenScope,
  type ScopeContext,
  type ScopeState,
} from '../scopeModel';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const ctx: ScopeContext = {
  selectedProjectId: 'p1',
  runningSessionIds: new Set(['run']),
  recentlyViewedIds: ['b', 'a'],
  now: NOW,
};
const st = (scope: ScopeState['scope'], includeArchived = false): ScopeState => ({ scope, includeArchived });

describe('scope presets', () => {
  it('match the #12 SearchQuery preset ids', () => {
    assert.deepEqual([...SCOPE_PRESETS], [
      'current-project', 'all-projects', 'running', 'favorites', 'recently-viewed', 'recently-active', 'archived',
    ]);
    assert.equal(isScopePreset('running'), true);
    assert.equal(isScopePreset('nope'), false);
    assert.equal(isScopePreset(3), false);
  });
});

describe('widenScope', () => {
  it('current → all → +archived → fixed point', () => {
    let s = st('current-project');
    s = widenScope(s); assert.deepEqual(s, st('all-projects'));
    s = widenScope(s); assert.deepEqual(s, st('all-projects', true));
    assert.deepEqual(widenScope(s), s);
  });
  it('other presets just include archived; archived preset is fixed', () => {
    assert.deepEqual(widenScope(st('favorites')), st('favorites', true));
    assert.deepEqual(widenScope(st('archived')), st('archived'));
  });
});

describe('sessionInScope', () => {
  const s = (over: Partial<Parameters<typeof sessionInScope>[0]> = {}) => ({ id: 'x', projectId: 'p1', ...over });

  it('current-project needs a selected project and a match', () => {
    assert.equal(sessionInScope(s(), st('current-project'), ctx), true);
    assert.equal(sessionInScope(s({ projectId: 'p2' }), st('current-project'), ctx), false);
    assert.equal(sessionInScope(s(), st('current-project'), { ...ctx, selectedProjectId: null }), false);
  });
  it('all-projects, running, favorites, recently-viewed', () => {
    assert.equal(sessionInScope(s({ projectId: 'zz' }), st('all-projects'), ctx), true);
    assert.equal(sessionInScope(s({ id: 'run' }), st('running'), ctx), true);
    assert.equal(sessionInScope(s(), st('running'), ctx), false);
    assert.equal(sessionInScope(s({ lastActivity: '2026-11-05T11:55:00Z' }), st('running'), ctx), true, 'active 5 min ago');
    assert.equal(sessionInScope(s({ lastActivity: '2026-11-05T11:40:00Z' }), st('running'), ctx), false, 'active 20 min ago');
    assert.equal(sessionInScope(s({ starred: true }), st('favorites'), ctx), true);
    assert.equal(sessionInScope(s(), st('favorites'), ctx), false);
    assert.equal(sessionInScope(s({ id: 'a' }), st('recently-viewed'), ctx), true);
    assert.equal(sessionInScope(s(), st('recently-viewed'), ctx), false);
  });
  it('recently-active uses a 7-day window and rejects bad dates', () => {
    assert.equal(sessionInScope(s({ lastActivity: '2026-11-01T00:00:00Z' }), st('recently-active'), ctx), true);
    assert.equal(sessionInScope(s({ lastActivity: '2026-10-20T00:00:00Z' }), st('recently-active'), ctx), false);
    assert.equal(sessionInScope(s({ lastActivity: 'garbage' }), st('recently-active'), ctx), false);
    assert.equal(sessionInScope(s({ lastActivity: null }), st('recently-active'), ctx), false);
  });
  it('archived sessions need the toggle; archived preset shows only archived', () => {
    const arch = s({ isArchived: true });
    assert.equal(sessionInScope(arch, st('all-projects'), ctx), false);
    assert.equal(sessionInScope(arch, st('all-projects', true), ctx), true);
    assert.equal(sessionInScope(arch, st('current-project', true), ctx), true);
    assert.equal(sessionInScope(arch, st('archived'), ctx), true);
    assert.equal(sessionInScope(s(), st('archived'), ctx), false);
  });
});

describe('orderForScope', () => {
  it('orders recently-viewed by view recency, unknowns last, stable', () => {
    const items = [{ id: 'a' }, { id: 'z' }, { id: 'b' }];
    assert.deepEqual(orderForScope(items, st('recently-viewed'), ctx, (i) => i.id).map((i) => i.id), ['b', 'a', 'z']);
    assert.deepEqual(orderForScope(items, st('all-projects'), ctx, (i) => i.id).map((i) => i.id), ['a', 'z', 'b']);
  });
});

describe('recently viewed persistence', () => {
  it('records to front, dedupes, caps', () => {
    assert.deepEqual(recordRecentlyViewed(['a', 'b'], 'b'), ['b', 'a']);
    assert.deepEqual(recordRecentlyViewed(['a'], ''), ['a']);
    const long = Array.from({ length: RECENT_VIEWED_LIMIT }, (_, i) => `s${i}`);
    const next = recordRecentlyViewed(long, 'new');
    assert.equal(next.length, RECENT_VIEWED_LIMIT);
    assert.equal(next[0], 'new');
  });
  it('parses defensively', () => {
    assert.deepEqual(parseRecentlyViewed(null), []);
    assert.deepEqual(parseRecentlyViewed('{'), []);
    assert.deepEqual(parseRecentlyViewed('{"a":1}'), []);
    assert.deepEqual(parseRecentlyViewed('["a", 2, "", "b"]'), ['a', 'b']);
  });
});

describe('scope state persistence', () => {
  const fallback = st('current-project');
  it('round-trips and falls back field by field', () => {
    assert.deepEqual(parseScopeState(JSON.stringify(st('running', true)), fallback), st('running', true));
    assert.deepEqual(parseScopeState('{"scope":"bogus","includeArchived":true}', fallback), st('current-project', true));
    assert.deepEqual(parseScopeState('{"scope":"favorites","includeArchived":"yes"}', fallback), st('favorites'));
    assert.deepEqual(parseScopeState('not json', fallback), fallback);
    assert.deepEqual(parseScopeState(null, fallback), fallback);
    assert.deepEqual(parseScopeState('null', fallback), fallback);
  });
  it('current-project without a project falls back to all-projects', () => {
    assert.deepEqual(effectiveScope(st('current-project', true), null), st('all-projects', true));
    assert.deepEqual(effectiveScope(st('current-project'), 'p1'), st('current-project'));
    assert.deepEqual(effectiveScope(st('running'), null), st('running'));
  });
});
