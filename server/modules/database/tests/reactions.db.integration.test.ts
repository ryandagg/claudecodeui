import assert from 'node:assert/strict';
import test from 'node:test';

import { reactionsDb } from '@/modules/database/repositories/reactions.db.js';

import { withIsolatedDatabase } from './helpers.js';

// reactions has no user_id FK, so no user seeding is required.

test('add stores a reaction and getForSession returns it ordered by message index', async () => {
  await withIsolatedDatabase('reactions-db', () => {
    reactionsDb.add('sess-1', 2, 'assistant', 'second', 'thumbsup');
    reactionsDb.add('sess-1', 0, 'assistant', 'first', 'wtf');
    reactionsDb.add('sess-2', 0, 'assistant', 'other session', 'thumbsdown');

    const forSession = reactionsDb.getForSession('sess-1');
    assert.deepEqual(forSession.map((r) => r.message_index), [0, 2]);
    assert.equal(forSession[0].reaction, 'wtf');
    assert.equal(forSession[0].message_content, 'first');
  });
});

test('add returns the inserted row with a generated id', async () => {
  await withIsolatedDatabase('reactions-db', () => {
    const row = reactionsDb.add('sess-1', 0, 'user', null, 'thumbsup');
    assert.ok(Number.isInteger(row.id));
    assert.equal(row.session_id, 'sess-1');
    assert.equal(row.message_content, null);
    assert.equal(row.reaction, 'thumbsup');
  });
});

test('remove deletes by id and reports whether a row was removed', async () => {
  await withIsolatedDatabase('reactions-db', () => {
    const row = reactionsDb.add('sess-1', 0, 'assistant', 'x', 'thumbsup');
    assert.equal(reactionsDb.remove(row.id), true);
    assert.equal(reactionsDb.getForSession('sess-1').length, 0);
    // Removing again is a no-op.
    assert.equal(reactionsDb.remove(row.id), false);
  });
});

test('removeByMessage removes every reaction for a session/message pair', async () => {
  await withIsolatedDatabase('reactions-db', () => {
    reactionsDb.add('sess-1', 3, 'assistant', 'a', 'thumbsup');
    reactionsDb.add('sess-1', 3, 'assistant', 'a', 'thumbsdown');
    reactionsDb.add('sess-1', 4, 'assistant', 'b', 'wtf');

    assert.equal(reactionsDb.removeByMessage('sess-1', 3), true);
    assert.deepEqual(reactionsDb.getForSession('sess-1').map((r) => r.message_index), [4]);
    assert.equal(reactionsDb.removeByMessage('sess-1', 99), false);
  });
});

test('getAll and getByReaction paginate newest-first', async () => {
  await withIsolatedDatabase('reactions-db', () => {
    reactionsDb.add('s', 0, 'assistant', 'a', 'thumbsup');
    reactionsDb.add('s', 1, 'assistant', 'b', 'thumbsdown');
    reactionsDb.add('s', 2, 'assistant', 'c', 'thumbsup');

    assert.equal(reactionsDb.getAll().length, 3);
    // Limit + offset honored.
    assert.equal(reactionsDb.getAll(1, 0).length, 1);
    assert.equal(reactionsDb.getAll(1, 3).length, 0);

    const thumbsUp = reactionsDb.getByReaction('thumbsup');
    assert.equal(thumbsUp.length, 2);
    assert.ok(thumbsUp.every((r) => r.reaction === 'thumbsup'));
  });
});

test('count and countByReaction aggregate correctly', async () => {
  await withIsolatedDatabase('reactions-db', () => {
    assert.equal(reactionsDb.count(), 0);
    assert.deepEqual(reactionsDb.countByReaction(), {});

    reactionsDb.add('s', 0, 'assistant', 'a', 'thumbsup');
    reactionsDb.add('s', 1, 'assistant', 'b', 'thumbsup');
    reactionsDb.add('s', 2, 'assistant', 'c', 'wtf');

    assert.equal(reactionsDb.count(), 3);
    assert.deepEqual(reactionsDb.countByReaction(), { thumbsup: 2, wtf: 1 });
  });
});
