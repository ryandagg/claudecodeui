import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { userDb } from '@/modules/database/repositories/users.js';

/**
 * Runs `runTest` against a throwaway SQLite database.
 *
 * Each call points DATABASE_PATH at a fresh temp file, applies the real schema
 * + migrations, and restores the previous connection/env afterward — so the
 * suite exercises actual SQL and foreign-key enforcement (PRAGMA foreign_keys
 * is ON) without touching the developer's real ~/.cloudcli/auth.db.
 *
 * The `label` only shapes the temp-dir name to make stray dirs identifiable.
 */
export async function withIsolatedDatabase(
  label: string,
  runTest: () => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), `${label}-`));
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

/**
 * Seeds a user and returns its numeric id. Tables with a `user_id` foreign key
 * to `users(id)` need a real owner row before they will accept inserts.
 */
export function seedUser(username = 'tester', passwordHash = 'hash'): number {
  return Number(userDb.createUser(username, passwordHash).id);
}
