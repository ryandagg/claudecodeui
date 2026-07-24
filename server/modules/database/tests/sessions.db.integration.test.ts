import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
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
  });
});

test('createSession reactivates archived rows when the session becomes active again', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'First Name');
    sessionsDb.updateSessionIsArchived('session-reused', true);

    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'Updated Name');

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const restoredSession = sessionsDb.getSessionById('session-reused');

    assert.equal(activeSessions.length, 1);
    assert.equal(activeSessions[0]?.session_id, 'session-reused');
    assert.equal(activeSessions[0]?.custom_name, 'Updated Name');
    assert.equal(archivedSessions.length, 0);
    assert.equal(restoredSession?.isArchived, 0);
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
