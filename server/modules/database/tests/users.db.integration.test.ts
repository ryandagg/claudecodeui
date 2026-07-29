import assert from 'node:assert/strict';
import test from 'node:test';

import { getConnection } from '@/modules/database/connection.js';
import { userDb } from '@/modules/database/repositories/users.js';

import { withIsolatedDatabase } from './helpers.js';

test('hasUsers reflects whether any user rows exist', async () => {
  await withIsolatedDatabase('users-db', () => {
    assert.equal(userDb.hasUsers(), false);
    userDb.createUser('alice', 'hash-a');
    assert.equal(userDb.hasUsers(), true);
  });
});

test('createUser returns the new id and getUserByUsername returns the full row', async () => {
  await withIsolatedDatabase('users-db', () => {
    const created = userDb.createUser('alice', 'hash-a');
    assert.equal(created.username, 'alice');
    assert.equal(Number(created.id), 1);

    const row = userDb.getUserByUsername('alice');
    assert.ok(row);
    assert.equal(row?.username, 'alice');
    // getUserByUsername is the auth path, so it must expose the password hash.
    assert.equal(row?.password_hash, 'hash-a');
    assert.equal(row?.is_active, 1);
    assert.equal(row?.has_completed_onboarding, 0);
  });
});

test('createUser rejects a duplicate username via the UNIQUE constraint', async () => {
  await withIsolatedDatabase('users-db', () => {
    userDb.createUser('alice', 'hash-a');
    assert.throws(() => userDb.createUser('alice', 'hash-b'), /UNIQUE/i);
  });
});

test('getUserByUsername and getUserById ignore deactivated users', async () => {
  await withIsolatedDatabase('users-db', () => {
    const { id } = userDb.createUser('alice', 'hash-a');
    assert.ok(userDb.getUserByUsername('alice'));

    // The repository has no deactivate method; flip is_active directly to prove
    // the `is_active = 1` filter on the read paths.
    getConnection().prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(Number(id));

    assert.equal(userDb.getUserByUsername('alice'), undefined);
    assert.equal(userDb.getUserById(Number(id)), undefined);
  });
});

test('getUserById and getFirstUser return public fields without the password hash', async () => {
  await withIsolatedDatabase('users-db', () => {
    const { id } = userDb.createUser('alice', 'hash-a');
    userDb.createUser('bob', 'hash-b');

    const byId = userDb.getUserById(Number(id));
    assert.ok(byId);
    assert.equal(byId?.username, 'alice');
    assert.equal((byId as Record<string, unknown>).password_hash, undefined);

    const first = userDb.getFirstUser();
    assert.equal(first?.username, 'alice');
  });
});

test('getUserById returns undefined for an unknown id', async () => {
  await withIsolatedDatabase('users-db', () => {
    assert.equal(userDb.getUserById(999), undefined);
  });
});

test('updateLastLogin sets a timestamp and never throws for a missing user', async () => {
  await withIsolatedDatabase('users-db', () => {
    const { id } = userDb.createUser('alice', 'hash-a');
    assert.equal(userDb.getUserById(Number(id))?.last_login, null);

    userDb.updateLastLogin(Number(id));
    assert.notEqual(userDb.getUserById(Number(id))?.last_login, null);

    // Non-fatal by contract: updating a non-existent user is a no-op, not a throw.
    assert.doesNotThrow(() => userDb.updateLastLogin(999));
  });
});

test('updateGitConfig and getGitConfig round-trip the git identity', async () => {
  await withIsolatedDatabase('users-db', () => {
    const { id } = userDb.createUser('alice', 'hash-a');
    assert.deepEqual(userDb.getGitConfig(Number(id)), { git_name: null, git_email: null });

    userDb.updateGitConfig(Number(id), 'Alice', 'alice@example.com');
    assert.deepEqual(userDb.getGitConfig(Number(id)), {
      git_name: 'Alice',
      git_email: 'alice@example.com',
    });
  });
});

test('onboarding flag flips from false to true via completeOnboarding', async () => {
  await withIsolatedDatabase('users-db', () => {
    const { id } = userDb.createUser('alice', 'hash-a');
    assert.equal(userDb.hasCompletedOnboarding(Number(id)), false);

    userDb.completeOnboarding(Number(id));
    assert.equal(userDb.hasCompletedOnboarding(Number(id)), true);
  });
});
