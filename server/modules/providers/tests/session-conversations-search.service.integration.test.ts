import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { indexFileIncrementally } from '@/modules/providers/services/session-index.service.js';
import {
  searchConversations,
  sessionConversationsSearchService,
} from '@/modules/providers/services/session-conversations-search.service.js';

/**
 * Runs `runTest` against a fresh temp DB plus a temp directory for transcript
 * fixtures. Mirrors the isolation used by session-index.service tests.
 */
async function withIsolatedIndex(runTest: (fixtureDir: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'conv-search-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
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

function jsonlLine(entry: unknown): string {
  return `${JSON.stringify(entry)}\n`;
}

const assistantText = (text: string, uuid: string) =>
  jsonlLine({ message: { role: 'assistant', content: text }, timestamp: '2026-07-24T00:00:01Z', uuid });

/** Seeds one indexed transcript + session row, returns the sessionId. */
async function seedSession(opts: {
  dir: string;
  fileName: string;
  sessionId: string;
  projectPath: string;
  marker: string;
}): Promise<string> {
  const file = path.join(opts.dir, opts.fileName);
  await writeFile(file, assistantText(`conversation body ${opts.marker} tail`, `${opts.sessionId}-a1`));
  await indexFileIncrementally(file, opts.projectPath);
  return sessionsDb.createSession(
    opts.sessionId,
    'claude',
    opts.projectPath,
    undefined,
    '2026-07-24T00:00:00Z',
    '2026-07-24T00:00:01Z',
    file,
  );
}

test('searchArchivedSessionIds finds content in archived sessions and archived-project sessions, not active ones', async () => {
  await withIsolatedIndex(async (dir) => {
    // Active session under an active project — must NOT be an archive hit.
    await seedSession({
      dir,
      fileName: 'active.jsonl',
      sessionId: 'sess-active',
      projectPath: '/proj/active',
      marker: 'zqactivemarker',
    });

    // Archived session under an active project.
    const archivedSessionId = await seedSession({
      dir,
      fileName: 'archived-session.jsonl',
      sessionId: 'sess-archived',
      projectPath: '/proj/active',
      marker: 'zqarchivedsessionmarker',
    });
    sessionsDb.updateSessionIsArchived(archivedSessionId, true);

    // Session under an archived project.
    const archivedProjectSessionId = await seedSession({
      dir,
      fileName: 'archived-project.jsonl',
      sessionId: 'sess-archived-project',
      projectPath: '/proj/archived',
      marker: 'zqarchivedprojectmarker',
    });
    projectsDb.updateProjectIsArchived('/proj/archived', true);

    // Archived session content is reachable.
    assert.deepEqual(
      sessionConversationsSearchService.searchArchivedSessionIds('zqarchivedsessionmarker'),
      [archivedSessionId],
    );

    // Archived-project session content is reachable too.
    assert.deepEqual(
      sessionConversationsSearchService.searchArchivedSessionIds('zqarchivedprojectmarker'),
      [archivedProjectSessionId],
    );

    // Active (non-archived) session content is NOT an archive hit.
    assert.deepEqual(sessionConversationsSearchService.searchArchivedSessionIds('zqactivemarker'), []);
  });
});

test('searchArchivedSessionIds returns nothing below the trigram floor', async () => {
  await withIsolatedIndex(async (dir) => {
    const archivedSessionId = await seedSession({
      dir,
      fileName: 'archived-session.jsonl',
      sessionId: 'sess-archived',
      projectPath: '/proj/active',
      marker: 'abcmarker',
    });
    sessionsDb.updateSessionIsArchived(archivedSessionId, true);

    assert.deepEqual(sessionConversationsSearchService.searchArchivedSessionIds('ab'), []);
  });
});

test('searchConversations tags archived sessions and excludes archived-project sessions', async () => {
  await withIsolatedIndex(async (dir) => {
    await seedSession({
      dir,
      fileName: 'active.jsonl',
      sessionId: 'sess-active',
      projectPath: '/proj/active',
      marker: 'sharedbodymarker',
    });
    const archivedSessionId = await seedSession({
      dir,
      fileName: 'archived-session.jsonl',
      sessionId: 'sess-archived',
      projectPath: '/proj/active',
      marker: 'sharedbodymarker',
    });
    sessionsDb.updateSessionIsArchived(archivedSessionId, true);
    await seedSession({
      dir,
      fileName: 'archived-project.jsonl',
      sessionId: 'sess-archived-project',
      projectPath: '/proj/archived',
      marker: 'sharedbodymarker',
    });
    projectsDb.updateProjectIsArchived('/proj/archived', true);

    const { results } = await searchConversations('sharedbodymarker', 50);
    const sessionsById = new Map(
      results.flatMap((project) => project.sessions.map((session) => [session.sessionId, session])),
    );

    // Active and archived (project active) sessions both surface in conversation
    // search; the archived one is flagged, the active one is not.
    assert.equal(sessionsById.get('sess-active')?.isArchived, false);
    assert.equal(sessionsById.get('sess-archived')?.isArchived, true);
    // Archived-project session is excluded from conversation search entirely.
    assert.equal(sessionsById.has('sess-archived-project'), false);
  });
});
