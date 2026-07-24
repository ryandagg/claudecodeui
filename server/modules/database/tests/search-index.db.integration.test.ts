import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import {
  searchIndexDb,
  toFtsMatchLiteral,
  type IndexableMessage,
} from '@/modules/database/repositories/search-index.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'search-index-db-'));
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

function message(seq: number, text: string, role = 'assistant'): IndexableMessage {
  return { role, text, timestamp: null, messageUuid: `uuid-${seq}`, seq };
}

test('trigram MATCH finds a substring inside a larger word', async () => {
  await withIsolatedDatabase(() => {
    searchIndexDb.replaceFileMessages(
      '/a.jsonl',
      '/proj',
      [message(0, 'the configuration was reconfigured twice')],
      42,
      42,
    );

    const hits = searchIndexDb.search(toFtsMatchLiteral('figur'), 10);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.jsonl_path, '/a.jsonl');
    assert.match(hits[0]?.body ?? '', /configuration/);
  });
});

test('MATCH treats operator-like input as a literal substring (no throw)', async () => {
  await withIsolatedDatabase(() => {
    searchIndexDb.replaceFileMessages(
      '/b.jsonl',
      '/proj',
      [
        message(0, 'ran rm -rf ./build to clean up'),
        message(1, 'email me at foo@bar.com please'),
      ],
      10,
      10,
    );

    // `rm -rf` would throw "no such column: rf" if passed raw to MATCH.
    const rmHits = searchIndexDb.search(toFtsMatchLiteral('rm -rf'), 10);
    assert.equal(rmHits.length, 1);
    assert.match(rmHits[0]?.body ?? '', /rm -rf/);

    const emailHits = searchIndexDb.search(toFtsMatchLiteral('foo@bar.com'), 10);
    assert.equal(emailHits.length, 1);
    assert.match(emailHits[0]?.body ?? '', /foo@bar\.com/);
  });
});

test('MATCH is case-insensitive', async () => {
  await withIsolatedDatabase(() => {
    searchIndexDb.replaceFileMessages('/c.jsonl', '/proj', [message(0, 'Ran the Bash tool')], 5, 5);

    assert.equal(searchIndexDb.search(toFtsMatchLiteral('bash'), 10).length, 1);
    assert.equal(searchIndexDb.search(toFtsMatchLiteral('BASH'), 10).length, 1);
  });
});

test('deleteByJsonlPath removes only that file and its cursor', async () => {
  await withIsolatedDatabase(() => {
    searchIndexDb.replaceFileMessages('/keep.jsonl', '/proj', [message(0, 'keepable payload')], 5, 5);
    searchIndexDb.replaceFileMessages('/drop.jsonl', '/proj', [message(0, 'droppable payload')], 5, 5);

    searchIndexDb.deleteByJsonlPath('/drop.jsonl');

    assert.equal(searchIndexDb.search(toFtsMatchLiteral('payload'), 10).length, 1);
    assert.equal(searchIndexDb.getFileCursor('/drop.jsonl'), null);
    assert.notEqual(searchIndexDb.getFileCursor('/keep.jsonl'), null);
  });
});

test('deleteByProjectPath removes every file under a project', async () => {
  await withIsolatedDatabase(() => {
    searchIndexDb.replaceFileMessages('/x.jsonl', '/proj-a', [message(0, 'alpha content')], 5, 5);
    searchIndexDb.replaceFileMessages('/y.jsonl', '/proj-a', [message(0, 'alpha content two')], 5, 5);
    searchIndexDb.replaceFileMessages('/z.jsonl', '/proj-b', [message(0, 'alpha elsewhere')], 5, 5);

    searchIndexDb.deleteByProjectPath('/proj-a');

    const hits = searchIndexDb.search(toFtsMatchLiteral('alpha'), 10);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.project_path, '/proj-b');
    assert.equal(searchIndexDb.getFileCursor('/x.jsonl'), null);
    assert.equal(searchIndexDb.getFileCursor('/y.jsonl'), null);
  });
});

test('getFileCursor round-trips indexed bytes and file size', async () => {
  await withIsolatedDatabase(() => {
    searchIndexDb.replaceFileMessages('/cursor.jsonl', '/proj', [message(0, 'cursor content here')], 120, 175);

    const cursor = searchIndexDb.getFileCursor('/cursor.jsonl');
    assert.equal(cursor?.indexed_bytes, 120);
    assert.equal(cursor?.file_size, 175);
  });
});

test('appendFileMessages adds rows without dropping existing ones and advances the cursor', async () => {
  await withIsolatedDatabase(() => {
    searchIndexDb.replaceFileMessages('/grow.jsonl', '/proj', [message(0, 'first line marker')], 20, 20);
    searchIndexDb.appendFileMessages('/grow.jsonl', '/proj', [message(1, 'second line marker')], 45, 45);

    assert.equal(searchIndexDb.search(toFtsMatchLiteral('marker'), 10).length, 2);
    const cursor = searchIndexDb.getFileCursor('/grow.jsonl');
    assert.equal(cursor?.indexed_bytes, 45);
    assert.equal(cursor?.file_size, 45);
  });
});

test('replaceFileMessages replaces prior rows for the same file', async () => {
  await withIsolatedDatabase(() => {
    searchIndexDb.replaceFileMessages('/re.jsonl', '/proj', [message(0, 'stale original body')], 20, 20);
    searchIndexDb.replaceFileMessages('/re.jsonl', '/proj', [message(0, 'fresh replacement body')], 24, 24);

    assert.equal(searchIndexDb.search(toFtsMatchLiteral('stale'), 10).length, 0);
    assert.equal(searchIndexDb.search(toFtsMatchLiteral('fresh'), 10).length, 1);
    assert.equal(searchIndexDb.countIndexedFiles(), 1);
  });
});

test('clearAll empties the index and cursors', async () => {
  await withIsolatedDatabase(() => {
    searchIndexDb.replaceFileMessages('/one.jsonl', '/proj', [message(0, 'wipe me')], 5, 5);
    searchIndexDb.clearAll();

    assert.equal(searchIndexDb.countIndexedFiles(), 0);
    assert.equal(searchIndexDb.search(toFtsMatchLiteral('wipe'), 10).length, 0);
  });
});
