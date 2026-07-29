import assert from 'node:assert/strict';
import test from 'node:test';

import { getConnection } from '@/modules/database/connection.js';
import { credentialsDb } from '@/modules/database/repositories/credentials.js';
import { githubTokensDb } from '@/modules/database/repositories/github-tokens.js';

import { seedUser, withIsolatedDatabase } from './helpers.js';

// ---------------------------------------------------------------------------
// credentialsDb
// ---------------------------------------------------------------------------
test('createCredential returns a safe result and getCredentials hides the raw value', async () => {
  await withIsolatedDatabase('credentials-db', () => {
    const userId = seedUser();
    const created = credentialsDb.createCredential(userId, 'my-token', 'github_token', 'secret-value', 'desc');
    assert.equal(created.credentialName, 'my-token');
    assert.equal(created.credentialType, 'github_token');

    const listed = credentialsDb.getCredentials(userId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].credential_name, 'my-token');
    assert.equal(listed[0].description, 'desc');
    assert.equal(listed[0].is_active, 1);
    // The public row shape must never leak the credential value.
    assert.equal((listed[0] as Record<string, unknown>).credential_value, undefined);
  });
});

test('createCredential rejects a credential for a non-existent user (FK enforced)', async () => {
  await withIsolatedDatabase('credentials-db', () => {
    assert.throws(
      () => credentialsDb.createCredential(999, 'orphan', 'github_token', 'v'),
      /FOREIGN KEY/i,
    );
  });
});

test('getCredentials filters by type and orders newest-first', async () => {
  await withIsolatedDatabase('credentials-db', () => {
    const userId = seedUser();
    credentialsDb.createCredential(userId, 'gh', 'github_token', 'v1');
    credentialsDb.createCredential(userId, 'gl', 'gitlab_token', 'v2');

    const onlyGithub = credentialsDb.getCredentials(userId, 'github_token');
    assert.deepEqual(onlyGithub.map((c) => c.credential_name), ['gh']);

    const all = credentialsDb.getCredentials(userId);
    assert.equal(all.length, 2);
  });
});

test('getActiveCredential returns the most recent active value and null once toggled off', async () => {
  await withIsolatedDatabase('credentials-db', () => {
    const userId = seedUser();
    const first = credentialsDb.createCredential(userId, 'old', 'github_token', 'old-value');
    const second = credentialsDb.createCredential(userId, 'new', 'github_token', 'new-value');

    // SQLite CURRENT_TIMESTAMP is second-granular, so same-second inserts tie on
    // created_at. Force a definite ordering to test "most recent active wins".
    getConnection()
      .prepare("UPDATE user_credentials SET created_at = '2020-01-01 00:00:00' WHERE id = ?")
      .run(Number(first.id));

    // Two active tokens of the same type → the newest wins.
    assert.equal(credentialsDb.getActiveCredential(userId, 'github_token'), 'new-value');

    // Disabling the newest falls back to the older active one.
    assert.equal(credentialsDb.toggleCredential(userId, Number(second.id), false), true);
    assert.equal(credentialsDb.getActiveCredential(userId, 'github_token'), 'old-value');

    // Disabling both yields null.
    assert.equal(credentialsDb.toggleCredential(userId, Number(first.id), false), true);
    assert.equal(credentialsDb.getActiveCredential(userId, 'github_token'), null);
  });
});

test('deleteCredential is scoped to the owning user', async () => {
  await withIsolatedDatabase('credentials-db', () => {
    const alice = seedUser('alice');
    const bob = seedUser('bob');
    const token = credentialsDb.createCredential(alice, 't', 'github_token', 'v');

    // Bob cannot delete Alice's credential.
    assert.equal(credentialsDb.deleteCredential(bob, Number(token.id)), false);
    assert.equal(credentialsDb.getCredentials(alice).length, 1);

    // The owner can.
    assert.equal(credentialsDb.deleteCredential(alice, Number(token.id)), true);
    assert.equal(credentialsDb.getCredentials(alice).length, 0);
  });
});

// ---------------------------------------------------------------------------
// githubTokensDb — thin, type-scoped wrapper over credentialsDb
// ---------------------------------------------------------------------------
test('githubTokensDb stores tokens under the github_token type and reads them back', async () => {
  await withIsolatedDatabase('credentials-db', () => {
    const userId = seedUser();
    githubTokensDb.createGithubToken(userId, 'ci', 'ghp_abc', 'CI token');
    // A non-github credential must not appear in the github-scoped list.
    credentialsDb.createCredential(userId, 'gl', 'gitlab_token', 'glpat');

    const tokens = githubTokensDb.getGithubTokens(userId);
    assert.deepEqual(tokens.map((t) => t.credential_name), ['ci']);
    assert.equal(githubTokensDb.getActiveGithubToken(userId), 'ghp_abc');
  });
});

test('getGithubTokenById exposes a github_token alias and respects active state', async () => {
  await withIsolatedDatabase('credentials-db', () => {
    const userId = seedUser();
    const created = githubTokensDb.createGithubToken(userId, 'ci', 'ghp_abc');
    const tokenId = Number(created.id);

    const found = githubTokensDb.getGithubTokenById(userId, tokenId);
    assert.equal(found?.github_token, 'ghp_abc');
    assert.equal(found?.credential_value, 'ghp_abc');

    // Toggling inactive removes it from the active-only lookup.
    assert.equal(githubTokensDb.toggleGithubToken(userId, tokenId, false), true);
    assert.equal(githubTokensDb.getGithubTokenById(userId, tokenId), null);
    assert.equal(githubTokensDb.getActiveGithubToken(userId), null);
  });
});

test('deleteGithubToken removes the underlying credential', async () => {
  await withIsolatedDatabase('credentials-db', () => {
    const userId = seedUser();
    const created = githubTokensDb.createGithubToken(userId, 'ci', 'ghp_abc');

    assert.equal(githubTokensDb.deleteGithubToken(userId, Number(created.id)), true);
    assert.equal(githubTokensDb.getGithubTokens(userId).length, 0);
  });
});
