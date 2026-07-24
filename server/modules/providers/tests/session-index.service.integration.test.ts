import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, searchIndexDb, sessionsDb, toFtsMatchLiteral } from '@/modules/database/index.js';
import { backfillAll, indexFileIncrementally } from '@/modules/providers/services/session-index.service.js';

/**
 * Runs `runTest` against a fresh temp DB plus a temp directory for transcript
 * fixtures. Both the DB path and the fixture dir are cleaned up afterward.
 */
async function withIsolatedIndex(
  runTest: (fixtureDir: string) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-index-'));
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

const userText = (text: string, uuid: string) =>
  jsonlLine({ message: { role: 'user', content: text }, timestamp: '2026-07-24T00:00:00Z', uuid });

const assistantText = (text: string, uuid: string) =>
  jsonlLine({ message: { role: 'assistant', content: text }, timestamp: '2026-07-24T00:00:01Z', uuid });

const toolUse = (name: string, uuid: string) =>
  jsonlLine({
    message: { role: 'assistant', content: [{ type: 'tool_use', name, input: {} }] },
    timestamp: '2026-07-24T00:00:02Z',
    uuid,
  });

test('indexFileIncrementally parses text and tool names from a fixture', async () => {
  await withIsolatedIndex(async (dir) => {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(
      file,
      userText('please refactor the configuration loader', 'u1') +
        assistantText('done, updated the loader', 'a1') +
        toolUse('Bash', 'a2'),
    );

    await indexFileIncrementally(file, '/proj');

    // Substring match against user text.
    assert.equal(searchIndexDb.search(toFtsMatchLiteral('figur'), 10).length, 1);
    // Tool name is indexed.
    assert.equal(searchIndexDb.search(toFtsMatchLiteral('Bash'), 10).length, 1);
    // Assistant text is indexed with its role.
    const loaderHits = searchIndexDb.search(toFtsMatchLiteral('updated the loader'), 10);
    assert.equal(loaderHits.length, 1);
    assert.equal(loaderHits[0]?.role, 'assistant');
  });
});

test('a second pass over an appended file only indexes the new lines', async () => {
  await withIsolatedIndex(async (dir) => {
    const file = path.join(dir, 'grow.jsonl');
    await writeFile(file, assistantText('alpha marker line', 'a1'));
    await indexFileIncrementally(file, '/proj');

    const firstCursor = searchIndexDb.getFileCursor(path.resolve(file));
    assert.notEqual(firstCursor, null);
    assert.equal(searchIndexDb.search(toFtsMatchLiteral('marker'), 10).length, 1);

    await appendFile(file, assistantText('beta marker line', 'a2'));
    await indexFileIncrementally(file, '/proj');

    const secondCursor = searchIndexDb.getFileCursor(path.resolve(file));
    assert.equal(searchIndexDb.search(toFtsMatchLiteral('marker'), 10).length, 2);
    assert.ok((secondCursor?.indexed_bytes ?? 0) > (firstCursor?.indexed_bytes ?? 0));
  });
});

test('an unchanged file is a no-op on the next pass', async () => {
  await withIsolatedIndex(async (dir) => {
    const file = path.join(dir, 'stable.jsonl');
    await writeFile(file, assistantText('stable content here', 'a1'));

    await indexFileIncrementally(file, '/proj');
    const before = searchIndexDb.getFileCursor(path.resolve(file));

    await indexFileIncrementally(file, '/proj');
    const after = searchIndexDb.getFileCursor(path.resolve(file));

    assert.deepEqual(after, before);
    assert.equal(searchIndexDb.search(toFtsMatchLiteral('stable'), 10).length, 1);
  });
});

test('a shrunk (rewritten) file triggers a full re-index', async () => {
  await withIsolatedIndex(async (dir) => {
    const file = path.join(dir, 'rewrite.jsonl');
    await writeFile(
      file,
      assistantText('original body one', 'a1') + assistantText('original body two', 'a2'),
    );
    await indexFileIncrementally(file, '/proj');
    assert.equal(searchIndexDb.search(toFtsMatchLiteral('original'), 10).length, 2);

    // Rewrite the file smaller with entirely new content.
    await writeFile(file, assistantText('replacement body', 'b1'));
    await indexFileIncrementally(file, '/proj');

    assert.equal(searchIndexDb.search(toFtsMatchLiteral('original'), 10).length, 0);
    assert.equal(searchIndexDb.search(toFtsMatchLiteral('replacement'), 10).length, 1);
  });
});

test('a transcript ending mid-line leaves the partial line for the next pass', async () => {
  await withIsolatedIndex(async (dir) => {
    const file = path.join(dir, 'partial.jsonl');
    const completeLine = assistantText('complete first line', 'a1');
    // Second line has no trailing newline — it is still being written.
    const partial = JSON.stringify({ message: { role: 'assistant', content: 'partial second line' }, uuid: 'a2' });
    await writeFile(file, completeLine + partial);

    await indexFileIncrementally(file, '/proj');

    // Only the complete line is indexed; the partial one is deferred.
    assert.equal(searchIndexDb.search(toFtsMatchLiteral('complete first'), 10).length, 1);
    assert.equal(searchIndexDb.search(toFtsMatchLiteral('partial second'), 10).length, 0);

    // The cursor stops at the end of the complete line, so the partial line is
    // re-read once it is terminated by a newline.
    const cursor = searchIndexDb.getFileCursor(path.resolve(file));
    assert.equal(cursor?.indexed_bytes, Buffer.byteLength(completeLine, 'utf8'));

    await appendFile(file, '\n');
    await indexFileIncrementally(file, '/proj');
    assert.equal(searchIndexDb.search(toFtsMatchLiteral('partial second'), 10).length, 1);
  });
});

test('backfillAll indexes archived sessions alongside active ones', async () => {
  await withIsolatedIndex(async (dir) => {
    const activeFile = path.join(dir, 'active.jsonl');
    const archivedFile = path.join(dir, 'archived.jsonl');
    await writeFile(activeFile, assistantText('shared needle in an active session', 'a1'));
    await writeFile(archivedFile, assistantText('shared needle in an archived session', 'b1'));

    sessionsDb.createSession('s-active', 'claude', '/proj', 'Active', undefined, undefined, activeFile);
    sessionsDb.createSession('s-archived', 'claude', '/proj', 'Archived', undefined, undefined, archivedFile);
    sessionsDb.updateSessionIsArchived('s-archived', true);

    const { indexedFiles } = await backfillAll();

    // Both transcripts are indexed: archiving hides a session from the active
    // list, it does not remove it from searchable history.
    assert.equal(indexedFiles, 2);
    const hits = searchIndexDb.search(toFtsMatchLiteral('shared needle'), 10);
    assert.equal(hits.length, 2);
    assert.deepEqual(
      hits.map((hit) => path.basename(hit.jsonl_path)).sort(),
      ['active.jsonl', 'archived.jsonl'],
    );
  });
});

test('multi-byte characters keep the byte cursor aligned to line boundaries', async () => {
  await withIsolatedIndex(async (dir) => {
    const file = path.join(dir, 'utf8.jsonl');
    const line = assistantText('café configuration — naïve', 'a1');
    await writeFile(file, line);

    await indexFileIncrementally(file, '/proj');

    assert.equal(searchIndexDb.search(toFtsMatchLiteral('figur'), 10).length, 1);
    const cursor = searchIndexDb.getFileCursor(path.resolve(file));
    // Cursor must equal the UTF-8 byte length, not the JS string length.
    assert.equal(cursor?.indexed_bytes, Buffer.byteLength(line, 'utf8'));
  });
});
