import { getConnection } from '@/modules/database/connection.js';

export const userSettingsDb = {
  get(userId: number): Record<string, string> {
    const db = getConnection();
    const rows = db
      .prepare('SELECT key, value FROM user_settings WHERE user_id = ?')
      .all(userId) as { key: string; value: string }[];

    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  },

  put(userId: number, settings: Record<string, string>): void {
    const db = getConnection();
    const upsert = db.prepare(
      `INSERT INTO user_settings (user_id, key, value, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, key) DO UPDATE SET
         value = excluded.value,
         updated_at = CURRENT_TIMESTAMP`
    );

    const transaction = db.transaction((entries: [string, string][]) => {
      for (const [key, value] of entries) {
        upsert.run(userId, key, value);
      }
    });

    transaction(Object.entries(settings));
  },

  delete(userId: number, key: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, key);
  },
};
