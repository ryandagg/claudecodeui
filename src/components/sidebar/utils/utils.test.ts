import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project } from '../../../types/app';
import type { SessionWithProvider } from '../types/types';

import {
  clearLegacyStarredProjectIds,
  compilePatterns,
  createSessionViewModel,
  filterProjects,
  getAllSessions,
  getProjectLastActivity,
  getSessionName,
  getTaskIndicatorStatus,
  normalizeProjectForSettings,
  parseHiddenSessionPatterns,
  parseProjectSortOrder,
  readLegacyStarredProjectIds,
  sortProjects,
} from './utils';

// The i18n `t` stub echoes keys so name-fallback assertions stay deterministic.
const t = ((key: string) => key) as never;

const project = (overrides: Partial<Project>): Project => ({
  projectId: 'p1',
  displayName: 'Project One',
  fullPath: '/repos/p1',
  ...overrides,
}) as Project;

const session = (overrides: Record<string, unknown>): SessionWithProvider => ({
  id: 's1',
  ...overrides,
}) as SessionWithProvider;

// ---------------------------------------------------------------------------
// parseProjectSortOrder
// ---------------------------------------------------------------------------
test('parseProjectSortOrder defaults to name unless date is given', () => {
  assert.equal(parseProjectSortOrder('date'), 'date');
  assert.equal(parseProjectSortOrder('name'), 'name');
  assert.equal(parseProjectSortOrder('garbage'), 'name');
  assert.equal(parseProjectSortOrder(null), 'name');
});

// ---------------------------------------------------------------------------
// hidden-session patterns
// ---------------------------------------------------------------------------
test('parseHiddenSessionPatterns returns defaults for null/invalid and parses arrays', () => {
  assert.deepEqual(parseHiddenSessionPatterns(null), ['^ping$']);
  assert.deepEqual(parseHiddenSessionPatterns('not json'), ['^ping$']);
  assert.deepEqual(parseHiddenSessionPatterns('["^a$","b"]'), ['^a$', 'b']);
});

test('compilePatterns skips invalid regex sources', () => {
  const regexes = compilePatterns(['^ok$', '[unterminated']);
  assert.equal(regexes.length, 1);
  assert.equal(regexes[0].test('ok'), true);
});

// ---------------------------------------------------------------------------
// session view model + naming
// ---------------------------------------------------------------------------
test('getSessionName prefers summary, then name, then the i18n fallback', () => {
  assert.equal(getSessionName(session({ summary: 'S', name: 'N' }), t), 'S');
  assert.equal(getSessionName(session({ name: 'N' }), t), 'N');
  assert.equal(getSessionName(session({}), t), 'projects.newSession');
});

test('createSessionViewModel marks recent sessions active using injected currentTime', () => {
  const now = new Date('2026-01-15T12:00:00.000Z');
  const recent = createSessionViewModel(
    session({ lastActivity: '2026-01-15T11:55:00.000Z', messageCount: 4 }),
    now,
    t,
  );
  assert.equal(recent.isActive, true); // 5 min ago < 10 min
  assert.equal(recent.messageCount, 4);

  const stale = createSessionViewModel(session({ lastActivity: '2026-01-15T11:00:00.000Z' }), now, t);
  assert.equal(stale.isActive, false); // 60 min ago
});

// ---------------------------------------------------------------------------
// getAllSessions / getProjectLastActivity
// ---------------------------------------------------------------------------
test('getAllSessions sorts newest-first and filters hidden sessions', () => {
  const proj = project({
    sessions: [
      session({ id: 'old', lastActivity: '2026-01-01T00:00:00.000Z' }),
      session({ id: 'ping', name: 'ping', lastActivity: '2026-01-10T00:00:00.000Z' }),
      session({ id: 'new', lastActivity: '2026-01-09T00:00:00.000Z' }),
    ],
  });
  const hidden = compilePatterns(['^ping$']);
  const sessions = getAllSessions(proj, hidden);
  assert.deepEqual(sessions.map((s) => s.id), ['new', 'old']);
  // Every returned session is tagged with a provider (defaulting to claude).
  assert.equal(sessions[0].__provider, 'claude');
});

test('getProjectLastActivity returns the newest session date (epoch 0 when empty)', () => {
  const proj = project({
    sessions: [
      session({ id: 'a', lastActivity: '2026-01-01T00:00:00.000Z' }),
      session({ id: 'b', lastActivity: '2026-02-01T00:00:00.000Z' }),
    ],
  });
  assert.equal(getProjectLastActivity(proj).toISOString(), '2026-02-01T00:00:00.000Z');
  assert.equal(getProjectLastActivity(project({ sessions: [] })).getTime(), 0);
});

// ---------------------------------------------------------------------------
// sortProjects
// ---------------------------------------------------------------------------
test('sortProjects puts starred first, then sorts by name', () => {
  const projects = [
    project({ projectId: 'b', displayName: 'Beta' }),
    project({ projectId: 'a', displayName: 'Alpha' }),
    project({ projectId: 'z', displayName: 'Zed', isStarred: true }),
  ];
  const sorted = sortProjects(projects, 'name');
  assert.deepEqual(sorted.map((p) => p.displayName), ['Zed', 'Alpha', 'Beta']);
});

test('sortProjects by date orders unstarred projects by latest activity', () => {
  const projects = [
    project({
      projectId: 'older',
      displayName: 'Older',
      sessions: [session({ id: 'o', lastActivity: '2026-01-01T00:00:00.000Z' })],
    }),
    project({
      projectId: 'newer',
      displayName: 'Newer',
      sessions: [session({ id: 'n', lastActivity: '2026-03-01T00:00:00.000Z' })],
    }),
  ];
  const sorted = sortProjects(projects, 'date');
  assert.deepEqual(sorted.map((p) => p.displayName), ['Newer', 'Older']);
});

// ---------------------------------------------------------------------------
// filterProjects
// ---------------------------------------------------------------------------
test('filterProjects matches on display name or path, case-insensitively', () => {
  const projects = [
    project({ projectId: 'a', displayName: 'Frontend', path: '/repos/frontend' }),
    project({ projectId: 'b', displayName: 'Backend', path: '/repos/backend' }),
  ];
  assert.deepEqual(filterProjects(projects, 'front').map((p) => p.projectId), ['a']);
  assert.deepEqual(filterProjects(projects, '/repos/back').map((p) => p.projectId), ['b']);
  assert.equal(filterProjects(projects, '   ').length, 2); // blank → unfiltered
});

// ---------------------------------------------------------------------------
// normalizeProjectForSettings
// ---------------------------------------------------------------------------
test('normalizeProjectForSettings keeps projectId as name and resolves paths', () => {
  const normalized = normalizeProjectForSettings(project({ projectId: 'p9', displayName: 'Nine', fullPath: '/f', path: '/p' }));
  assert.equal(normalized.name, 'p9');
  assert.equal(normalized.displayName, 'Nine');
  assert.equal(normalized.fullPath, '/f');
  assert.equal(normalized.path, '/p');
});

test('normalizeProjectForSettings falls back to projectId and fullPath when fields are blank', () => {
  const normalized = normalizeProjectForSettings(project({ projectId: 'p9', displayName: '  ', fullPath: '/f', path: '' }));
  assert.equal(normalized.displayName, 'p9');
  assert.equal(normalized.path, '/f');
});

// ---------------------------------------------------------------------------
// getTaskIndicatorStatus
// ---------------------------------------------------------------------------
test('getTaskIndicatorStatus reports the combined taskmaster + MCP state', () => {
  const configured = { hasMCPServer: true, isConfigured: true };
  assert.equal(
    getTaskIndicatorStatus(project({ taskmaster: { hasTaskmaster: true } }), configured),
    'fully-configured',
  );
  assert.equal(
    getTaskIndicatorStatus(project({ taskmaster: { hasTaskmaster: true } }), null),
    'taskmaster-only',
  );
  assert.equal(
    getTaskIndicatorStatus(project({}), configured),
    'mcp-only',
  );
  assert.equal(getTaskIndicatorStatus(project({}), null), 'not-configured');
});

test('getTaskIndicatorStatus treats a half-configured MCP server as absent', () => {
  // hasMCPServer without isConfigured must not count as configured.
  assert.equal(
    getTaskIndicatorStatus(project({}), { hasMCPServer: true, isConfigured: false }),
    'not-configured',
  );
});

// ---------------------------------------------------------------------------
// legacy starred-project localStorage helpers
// ---------------------------------------------------------------------------

// Minimal localStorage stub — Node has no DOM. Restored in finally so tests stay isolated.
type StorageStub = { getItem: (k: string) => string | null; removeItem: (k: string) => void };
const withLocalStorage = (stub: StorageStub, run: () => void) => {
  const globals = globalThis as { localStorage?: StorageStub };
  const previous = globals.localStorage;
  globals.localStorage = stub;
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete globals.localStorage;
    } else {
      globals.localStorage = previous;
    }
  }
};

test('readLegacyStarredProjectIds parses a trimmed, non-empty id array', () => {
  withLocalStorage(
    { getItem: () => JSON.stringify([' a ', 'b', '', 42]), removeItem: () => {} },
    () => {
      assert.deepEqual(readLegacyStarredProjectIds(), ['a', 'b', '42']);
    },
  );
});

test('readLegacyStarredProjectIds returns [] for missing, non-array, or malformed data', () => {
  withLocalStorage({ getItem: () => null, removeItem: () => {} }, () => {
    assert.deepEqual(readLegacyStarredProjectIds(), []);
  });
  withLocalStorage({ getItem: () => JSON.stringify({ not: 'array' }), removeItem: () => {} }, () => {
    assert.deepEqual(readLegacyStarredProjectIds(), []);
  });
  withLocalStorage({ getItem: () => 'not json', removeItem: () => {} }, () => {
    assert.deepEqual(readLegacyStarredProjectIds(), []);
  });
});

test('readLegacyStarredProjectIds swallows storage access errors', () => {
  withLocalStorage(
    { getItem: () => { throw new Error('blocked'); }, removeItem: () => {} },
    () => {
      assert.deepEqual(readLegacyStarredProjectIds(), []);
    },
  );
});

test('clearLegacyStarredProjectIds removes the legacy key and ignores storage errors', () => {
  let removed: string | null = null;
  withLocalStorage(
    { getItem: () => null, removeItem: (k) => { removed = k; } },
    () => clearLegacyStarredProjectIds(),
  );
  assert.equal(removed, 'starredProjects');

  // A throwing removeItem must not propagate.
  withLocalStorage(
    { getItem: () => null, removeItem: () => { throw new Error('blocked'); } },
    () => assert.doesNotThrow(() => clearLegacyStarredProjectIds()),
  );
});
