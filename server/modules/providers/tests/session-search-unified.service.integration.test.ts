import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { indexFileIncrementally } from '@/modules/providers/services/session-index.service.js';
import {
  searchConversations,
  searchSessions,
  sessionConversationsSearchService,
} from '@/modules/providers/services/session-conversations-search.service.js';

import { createSearchQuery, type SearchQuery } from '../../../../shared/search/query.js';

async function withIsolatedIndex(runTest: (fixtureDir: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'unified-search-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest(tempDirectory);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type Line = { role?: 'user' | 'assistant'; text: string; timestamp?: string };

function jsonl(sessionId: string, lines: Line[]): string {
  return lines
    .map((line, i) => {
      const role = line.role ?? 'assistant';
      const message = role === 'user'
        ? { role: 'user', content: line.text }
        : { role: 'assistant', content: line.text };
      return `${JSON.stringify({
        type: role,
        message,
        timestamp: line.timestamp ?? '2026-10-15T12:00:00Z',
        uuid: `${sessionId}-${i}`,
      })}\n`;
    })
    .join('');
}

async function seed(opts: {
  dir: string;
  sessionId: string;
  projectPath: string;
  lines: Line[];
  provider?: string;
}): Promise<string> {
  const file = path.join(opts.dir, `${opts.sessionId}.jsonl`);
  await writeFile(file, jsonl(opts.sessionId, opts.lines));
  await indexFileIncrementally(file, opts.projectPath);
  return sessionsDb.createSession(
    opts.sessionId,
    opts.provider ?? 'claude',
    opts.projectPath,
    undefined,
    '2026-10-15T00:00:00Z',
    '2026-10-15T00:00:01Z',
    file,
  );
}

const query = (text: string, overrides: Partial<SearchQuery> = {}) => createSearchQuery({ text, ...overrides });

function sessionIds(result: Awaited<ReturnType<typeof searchSessions>>): string[] {
  return result.results.flatMap((p) => p.sessions.map((s) => s.sessionId)).sort();
}

test('archived-only search is not starved by many stronger active hits', async () => {
  await withIsolatedIndex(async (dir) => {
    for (let i = 0; i < 120; i += 1) {
      await seed({
        dir,
        sessionId: `active-${i}`,
        projectPath: '/proj/active',
        lines: [{ text: 'zqneedle zqneedle zqneedle' }, { text: 'zqneedle zqneedle' }],
      });
    }
    const archived = await seed({
      dir,
      sessionId: 'archived-weak',
      projectPath: '/proj/active',
      lines: [{ text: `a long message with many other words and the zqneedle just once ${'filler '.repeat(40)}` }],
    });
    sessionsDb.updateSessionIsArchived(archived, true);

    // limit 1: the old 20× over-fetch (20 rows, all active) would have returned nothing.
    const result = await searchSessions(query('zqneedle', { archived: 'only' }), { limit: 1 });
    assert.deepEqual(sessionIds(result), [archived]);
    assert.deepEqual(sessionConversationsSearchService.searchArchivedSessionIds('zqneedle', 1), [archived]);
  });
});

test('archived modes: auto / exclude / include / only', async () => {
  await withIsolatedIndex(async (dir) => {
    const active = await seed({ dir, sessionId: 'active', projectPath: '/proj/a', lines: [{ text: 'zqmode' }] });
    const archivedSession = await seed({ dir, sessionId: 'arch', projectPath: '/proj/a', lines: [{ text: 'zqmode' }] });
    sessionsDb.updateSessionIsArchived(archivedSession, true);
    const archivedProject = await seed({ dir, sessionId: 'archproj', projectPath: '/proj/b', lines: [{ text: 'zqmode' }] });
    projectsDb.updateProjectIsArchived('/proj/b', true);

    const ids = async (archived: SearchQuery['archived']) => sessionIds(await searchSessions(query('zqmode', { archived })));
    assert.deepEqual(await ids('auto'), [active, archivedSession].sort());
    assert.deepEqual(await ids('exclude'), [active]);
    assert.deepEqual(await ids('include'), [active, archivedSession, archivedProject].sort());
    assert.deepEqual(await ids('only'), [archivedSession, archivedProject].sort());
  });
});

test('pagination: cursor walks every session exactly once, never splitting a session', async () => {
  await withIsolatedIndex(async (dir) => {
    const all: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      all.push(await seed({
        dir,
        sessionId: `s-${i}`,
        projectPath: `/proj/${i % 3}`,
        lines: [{ text: `zqpage one ${i}` }, { text: `zqpage two ${i}` }, { text: `zqpage three ${i}` }],
      }));
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await searchSessions(query('zqpage'), { limit: 4, cursor });
      for (const project of page.results) {
        for (const session of project.sessions) {
          assert.equal(session.matches.length, 2, 'each session carries its full (capped) match set');
          seen.push(session.sessionId);
        }
      }
      assert.ok(page.totalMatches >= 4 || page.nextCursor === null, 'only the last page may run short');
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);

    assert.equal(new Set(seen).size, seen.length, 'no session repeats across pages');
    assert.deepEqual([...seen].sort(), [...all].sort());
    assert.ok(pages >= 3);
  });
});

test('invalid cursor is treated as the first page', async () => {
  await withIsolatedIndex(async (dir) => {
    const id = await seed({ dir, sessionId: 'one', projectPath: '/p', lines: [{ text: 'zqcursor' }] });
    for (const cursor of ['garbage', '-5', '1.5', '']) {
      assert.deepEqual(sessionIds(await searchSessions(query('zqcursor'), { cursor })), [id]);
    }
    assert.equal((await searchSessions(query('zqcursor'))).nextCursor, null);
  });
});

test('project include / exclude by path, basename, or custom name; exclude wins', async () => {
  await withIsolatedIndex(async (dir) => {
    const a = await seed({ dir, sessionId: 'a', projectPath: '/repos/dashboard', lines: [{ text: 'zqproj' }] });
    const b = await seed({ dir, sessionId: 'b', projectPath: '/repos/signup', lines: [{ text: 'zqproj' }] });
    const c = await seed({ dir, sessionId: 'c', projectPath: '/repos/worktrees/x', lines: [{ text: 'zqproj' }] });

    const ids = async (projects: SearchQuery['projects']) => sessionIds(await searchSessions(query('zqproj', { projects })));
    assert.deepEqual(await ids({ include: ['dashboard'], exclude: [] }), [a]);
    assert.deepEqual(await ids({ include: ['/repos/signup/'], exclude: [] }), [b]);
    assert.deepEqual(await ids({ include: [], exclude: ['signup'] }), [a, c].sort());
    assert.deepEqual(await ids({ include: ['dashboard', 'signup'], exclude: ['Signup'] }), [a]);
    assert.deepEqual(await ids({ include: ['nope'], exclude: [] }), []);
  });
});

test('role and date filters run in SQL', async () => {
  await withIsolatedIndex(async (dir) => {
    const id = await seed({
      dir,
      sessionId: 'mixed',
      projectPath: '/p',
      lines: [
        { role: 'user', text: 'zqrole asked', timestamp: '2026-09-01T10:00:00Z' },
        { role: 'assistant', text: 'zqrole answered', timestamp: '2026-10-20T10:00:00Z' },
      ],
    });

    const roles = (await searchSessions(query('zqrole', { roles: ['user'] }))).results[0]?.sessions[0]?.matches.map((m) => m.role);
    assert.deepEqual(roles, ['user']);

    const after = await searchSessions(query('zqrole', { after: '2026-10-01' }));
    assert.deepEqual(after.results[0]?.sessions[0]?.matches.map((m) => m.role), ['assistant']);

    const relative = await searchSessions(query('zqrole', { after: '7d' }), { now: new Date('2026-10-25T00:00:00Z') });
    assert.deepEqual(sessionIds(relative), [id]);
    const tooRecent = await searchSessions(query('zqrole', { after: '1d' }), { now: new Date('2026-10-25T00:00:00Z') });
    assert.deepEqual(sessionIds(tooRecent), []);
  });
});

test('favorite and provider filters', async () => {
  await withIsolatedIndex(async (dir) => {
    const starred = await seed({ dir, sessionId: 'starred', projectPath: '/p', lines: [{ text: 'zqfav' }] });
    const plain = await seed({ dir, sessionId: 'plain', projectPath: '/p', lines: [{ text: 'zqfav' }] });
    sessionsDb.toggleSessionStar(starred);

    assert.deepEqual(sessionIds(await searchSessions(query('zqfav', { favorite: true }))), [starred]);
    assert.deepEqual(sessionIds(await searchSessions(query('zqfav'))), [starred, plain].sort());
    assert.deepEqual(sessionIds(await searchSessions(query('zqfav', { providers: ['codex'] }))), []);
    assert.deepEqual(sessionIds(await searchSessions(query('zqfav', { providers: ['claude'] }))), [starred, plain].sort());
  });
});

test('legacy searchConversations matches searchSessions defaults', async () => {
  await withIsolatedIndex(async (dir) => {
    await seed({ dir, sessionId: 'x', projectPath: '/p', lines: [{ text: 'zqlegacy one' }, { text: 'zqlegacy two' }] });
    const legacy = await searchConversations('zqlegacy', 50);
    const unified = await searchSessions(query('zqlegacy'), { limit: 50 });
    assert.deepEqual(legacy.results, unified.results);
    assert.equal(legacy.totalMatches, 2);
  });
});

test('below the trigram floor and aborted signals return nothing', async () => {
  await withIsolatedIndex(async (dir) => {
    await seed({ dir, sessionId: 'x', projectPath: '/p', lines: [{ text: 'abc' }] });
    assert.deepEqual((await searchSessions(query('ab'))).results, []);
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual((await searchSessions(query('abc'), { signal: controller.signal })).results, []);
  });
});

test('a cursor that lands mid-session snaps forward to the next session boundary', async () => {
  await withIsolatedIndex(async (dir) => {
    for (let i = 0; i < 4; i += 1) {
      await seed({
        dir,
        sessionId: `b-${i}`,
        projectPath: '/p',
        lines: [{ text: `zqsnap one ${i}` }, { text: `zqsnap two ${i}` }],
      });
    }
    // Boundaries are 0/2/4/6 (2 matches per session). Cursor 3 is mid-session.
    const full = await searchSessions(query('zqsnap'), { limit: 100 });
    const order = full.results.flatMap((p) => p.sessions.map((s) => s.sessionId));
    const snapped = await searchSessions(query('zqsnap'), { limit: 100, cursor: '3' });
    const got = snapped.results.flatMap((p) => p.sessions.map((s) => s.sessionId));
    assert.deepEqual(got, order.slice(2));
    for (const project of snapped.results) {
      for (const session of project.sessions) assert.equal(session.matches.length, 2);
    }
  });
});
