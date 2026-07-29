import assert from 'node:assert/strict';
import test from 'node:test';

import { appConfigDb } from '@/modules/database/repositories/app-config.js';
import { scanStateDb } from '@/modules/database/repositories/scan-state.db.js';
import { userSettingsDb } from '@/modules/database/repositories/user-settings.js';

import { seedUser, withIsolatedDatabase } from './helpers.js';

// ---------------------------------------------------------------------------
// userSettingsDb
// ---------------------------------------------------------------------------
test('userSettingsDb.put upserts a bag of key/value settings and get reads them back', async () => {
  await withIsolatedDatabase('kv-db', () => {
    const userId = seedUser();
    assert.deepEqual(userSettingsDb.get(userId), {});

    userSettingsDb.put(userId, { theme: 'dark', fontSize: '14' });
    assert.deepEqual(userSettingsDb.get(userId), { theme: 'dark', fontSize: '14' });

    // A second put with an overlapping key updates in place (ON CONFLICT).
    userSettingsDb.put(userId, { theme: 'light', density: 'compact' });
    assert.deepEqual(userSettingsDb.get(userId), {
      theme: 'light',
      fontSize: '14',
      density: 'compact',
    });
  });
});

test('userSettingsDb.delete removes a single key and is scoped per user', async () => {
  await withIsolatedDatabase('kv-db', () => {
    const alice = seedUser('alice');
    const bob = seedUser('bob');
    userSettingsDb.put(alice, { theme: 'dark' });
    userSettingsDb.put(bob, { theme: 'light' });

    userSettingsDb.delete(alice, 'theme');
    assert.deepEqual(userSettingsDb.get(alice), {});
    // Bob's identically-keyed setting is untouched.
    assert.deepEqual(userSettingsDb.get(bob), { theme: 'light' });
  });
});

test('userSettingsDb.put with an empty object is a no-op', async () => {
  await withIsolatedDatabase('kv-db', () => {
    const userId = seedUser();
    assert.doesNotThrow(() => userSettingsDb.put(userId, {}));
    assert.deepEqual(userSettingsDb.get(userId), {});
  });
});

// ---------------------------------------------------------------------------
// appConfigDb
// ---------------------------------------------------------------------------
test('appConfigDb.get returns null for a missing key and set upserts', async () => {
  await withIsolatedDatabase('kv-db', () => {
    assert.equal(appConfigDb.get('feature.x'), null);

    appConfigDb.set('feature.x', 'on');
    assert.equal(appConfigDb.get('feature.x'), 'on');

    // set is an upsert, not a duplicate insert.
    appConfigDb.set('feature.x', 'off');
    assert.equal(appConfigDb.get('feature.x'), 'off');
  });
});

test('getOrCreateJwtSecret persists a stable secret across calls', async () => {
  await withIsolatedDatabase('kv-db', () => {
    const first = appConfigDb.getOrCreateJwtSecret();
    assert.match(first, /^[0-9a-f]{128}$/); // 64 random bytes as hex
    // A second call returns the same persisted secret, not a fresh one.
    assert.equal(appConfigDb.getOrCreateJwtSecret(), first);
    assert.equal(appConfigDb.get('jwt_secret'), first);
  });
});

// ---------------------------------------------------------------------------
// scanStateDb
// ---------------------------------------------------------------------------
test('scanStateDb returns null before any scan and round-trips a stored timestamp', async () => {
  await withIsolatedDatabase('kv-db', () => {
    assert.equal(scanStateDb.getLastScannedAt(), null);

    const when = new Date('2026-03-04T05:06:07.000Z');
    scanStateDb.updateLastScannedAt(when);

    const read = scanStateDb.getLastScannedAt();
    assert.ok(read instanceof Date);
    // Stored at whole-second precision (SQLite text timestamp).
    assert.equal(read?.toISOString(), '2026-03-04T05:06:07.000Z');
  });
});

test('scanStateDb.updateLastScannedAt upserts the single row rather than duplicating it', async () => {
  await withIsolatedDatabase('kv-db', () => {
    scanStateDb.updateLastScannedAt(new Date('2026-01-01T00:00:00.000Z'));
    scanStateDb.updateLastScannedAt(new Date('2026-02-02T02:02:02.000Z'));

    assert.equal(scanStateDb.getLastScannedAt()?.toISOString(), '2026-02-02T02:02:02.000Z');
  });
});
