import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { searchIndexDb, toFtsMatchLiteral } from '@/modules/database/repositories/search-index.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
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

test('session archive queries hide archived rows from active project views', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-active', 'claude', '/workspace/demo-project', 'Active Session');
    sessionsDb.createSession('session-archived', 'claude', '/workspace/demo-project', 'Archived Session');
    sessionsDb.updateSessionIsArchived('session-archived', true);

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const activeProjectSessions = sessionsDb.getSessionsByProjectPath('/workspace/demo-project');
    const allProjectSessions = sessionsDb.getSessionsByProjectPathIncludingArchived('/workspace/demo-project');

    assert.deepEqual(activeSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(archivedSessions.map((session) => session.session_id), ['session-archived']);
    assert.deepEqual(activeProjectSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(
      allProjectSessions.map((session) => session.session_id).sort(),
      ['session-active', 'session-archived'],
    );
    assert.equal(sessionsDb.countSessionsByProjectPath('/workspace/demo-project'), 1);

    // Search indexes and queries archived transcripts too, so it reads through
    // this method rather than the active-only `getAllSessions()`.
    assert.deepEqual(
      sessionsDb.getAllSessionsIncludingArchived().map((session) => session.session_id).sort(),
      ['session-active', 'session-archived'],
    );
  });
});

test('createSession leaves an archived session archived when its transcript changes', async () => {
  // Regression: sync used to write `isArchived = 0` in its upsert, so merely
  // appending to an archived session's transcript silently un-archived it.
  // Archive state is owned by the user and no synchronizer may write it.
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'First Name');
    sessionsDb.updateSessionIsArchived('session-reused', true);

    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'Updated Name');

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const session = sessionsDb.getSessionById('session-reused');

    assert.equal(activeSessions.length, 0, 'an archived session must not reappear in active lists');
    assert.equal(archivedSessions.length, 1);
    assert.equal(session?.isArchived, 1);
    // The provider's title is derived, so it still refreshes.
    assert.equal(session?.custom_name, 'Updated Name');
  });
});

test('createSession preserves a starred session across re-sync', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-starred', 'claude', '/workspace/demo-project', 'Name');
    sessionsDb.toggleSessionStar('session-starred');
    const starredAt = sessionsDb.getSessionById('session-starred')?.starred_at;
    assert.ok(starredAt, 'precondition: session is starred');

    sessionsDb.createSession('session-starred', 'claude', '/workspace/demo-project', 'Name');

    assert.equal(sessionsDb.getSessionById('session-starred')?.starred_at, starredAt);
  });
});

test('transcript-derived data can be rebuilt without losing owned state', async () => {
  // The property the schema split exists for: derived rows are disposable.
  await withIsolatedDatabase(() => {
    const db = getConnection();
    sessionsDb.createSession('rebuild-me', 'claude', '/workspace/demo-project', 'Derived Name');
    sessionsDb.updateSessionIsArchived('rebuild-me', true);
    sessionsDb.toggleSessionStar('rebuild-me');

    db.exec('DELETE FROM session_transcripts');

    const session = sessionsDb.getSessionById('rebuild-me');
    assert.equal(session?.isArchived, 1, 'archive flag survives a derived-data wipe');
    assert.ok(session?.starred_at, 'star survives a derived-data wipe');

    // Re-deriving restores the transcript facts.
    sessionsDb.createSession('rebuild-me', 'claude', '/workspace/demo-project', 'Derived Name');
    assert.equal(sessionsDb.getSessionById('rebuild-me')?.custom_name, 'Derived Name');
  });
});

test('the session_rows view rejects writes aimed at owned state', async () => {
  // Owned state is unreachable through the read shape by construction.
  await withIsolatedDatabase(() => {
    const db = getConnection();
    sessionsDb.createSession('view-guard', 'claude', '/workspace/demo-project', 'Name');
    assert.throws(
      () => db.exec('UPDATE session_rows SET isArchived = 0'),
      /cannot modify session_rows/i,
    );
  });
});

test('repository reads normalize SQLite UTC timestamps to ISO strings', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('session-timezone', 'claude', '/workspace/demo-project');

    const row = sessionsDb.getSessionById('session-timezone');
    assert.ok(row?.created_at.endsWith('Z'));
    assert.ok(row?.updated_at.endsWith('Z'));
    assert.match(row?.created_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.match(row?.updated_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('deleteSessionById mirrors the deletion into the search index', async () => {
  await withIsolatedDatabase(() => {
    const jsonlPath = '/workspace/demo-project/session-delete.jsonl';
    sessionsDb.createSession('session-delete', 'claude', '/workspace/demo-project', 'Doomed', undefined, undefined, jsonlPath);
    searchIndexDb.replaceFileMessages(path.resolve(jsonlPath), '/workspace/demo-project', [
      { role: 'assistant', text: 'searchable body content', timestamp: null, messageUuid: 'u1', seq: 0 },
    ], 10, 10);
    assert.equal(searchIndexDb.search(toFtsMatchLiteral('searchable'), 10).length, 1);

    assert.equal(sessionsDb.deleteSessionById('session-delete'), true);

    assert.equal(searchIndexDb.search(toFtsMatchLiteral('searchable'), 10).length, 0);
    assert.equal(searchIndexDb.getFileCursor(path.resolve(jsonlPath)), null);
  });
});

test('deleteSessionById keeps the index when another session still references the file', async () => {
  await withIsolatedDatabase(() => {
    const sharedPath = '/workspace/demo-project/shared.jsonl';
    // Two rows keyed by different session ids but pointing at the same transcript
    // (the app-row/provider-row shape that exists mid-merge).
    sessionsDb.createSession('session-a', 'claude', '/workspace/demo-project', 'A', undefined, undefined, sharedPath);
    sessionsDb.createSession('session-b', 'claude', '/workspace/demo-project', 'B', undefined, undefined, sharedPath);
    searchIndexDb.replaceFileMessages(path.resolve(sharedPath), '/workspace/demo-project', [
      { role: 'assistant', text: 'shared transcript body', timestamp: null, messageUuid: 'u1', seq: 0 },
    ], 10, 10);

    // Deleting one row must not blind search for its sibling.
    sessionsDb.deleteSessionById('session-a');

    assert.equal(searchIndexDb.search(toFtsMatchLiteral('shared transcript'), 10).length, 1);
    assert.notEqual(searchIndexDb.getFileCursor(path.resolve(sharedPath)), null);
  });
});

test('deleteSessionsByProjectPath mirrors the deletion into the search index', async () => {
  await withIsolatedDatabase(() => {
    const projectPath = '/workspace/demo-project';
    sessionsDb.createSession('session-p1', 'claude', projectPath, 'One', undefined, undefined, `${projectPath}/one.jsonl`);
    searchIndexDb.replaceFileMessages(projectPath, projectPath, [
      { role: 'assistant', text: 'project scoped body', timestamp: null, messageUuid: 'u1', seq: 0 },
    ], 10, 10);
    assert.equal(searchIndexDb.search(toFtsMatchLiteral('project scoped'), 10).length, 1);

    sessionsDb.deleteSessionsByProjectPath(projectPath);

    assert.equal(searchIndexDb.search(toFtsMatchLiteral('project scoped'), 10).length, 0);
  });
});
