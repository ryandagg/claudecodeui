import { getConnection } from '@/modules/database/connection.js';

type ReactionRow = {
  id: number;
  session_id: string;
  message_index: number;
  message_role: string;
  message_content: string | null;
  reaction: string;
  created_at: string;
};

export type ReactionType = 'thumbsup' | 'thumbsdown' | 'wtf';

export const reactionsDb = {
  add(sessionId: string, messageIndex: number, messageRole: string, messageContent: string | null, reaction: ReactionType): ReactionRow {
    const db = getConnection();
    const stmt = db.prepare(
      `INSERT INTO reactions (session_id, message_index, message_role, message_content, reaction)
       VALUES (?, ?, ?, ?, ?)`
    );
    const result = stmt.run(sessionId, messageIndex, messageRole, messageContent, reaction);
    return {
      id: result.lastInsertRowid as number,
      session_id: sessionId,
      message_index: messageIndex,
      message_role: messageRole,
      message_content: messageContent,
      reaction,
      created_at: new Date().toISOString(),
    };
  },

  remove(id: number): boolean {
    const db = getConnection();
    const result = db.prepare('DELETE FROM reactions WHERE id = ?').run(id);
    return result.changes > 0;
  },

  removeByMessage(sessionId: string, messageIndex: number): boolean {
    const db = getConnection();
    const result = db.prepare(
      'DELETE FROM reactions WHERE session_id = ? AND message_index = ?'
    ).run(sessionId, messageIndex);
    return result.changes > 0;
  },

  getForSession(sessionId: string): ReactionRow[] {
    const db = getConnection();
    return db.prepare(
      'SELECT * FROM reactions WHERE session_id = ? ORDER BY message_index ASC'
    ).all(sessionId) as ReactionRow[];
  },

  getAll(limit = 200, offset = 0): ReactionRow[] {
    const db = getConnection();
    return db.prepare(
      'SELECT * FROM reactions ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(limit, offset) as ReactionRow[];
  },

  getByReaction(reaction: ReactionType, limit = 200, offset = 0): ReactionRow[] {
    const db = getConnection();
    return db.prepare(
      'SELECT * FROM reactions WHERE reaction = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(reaction, limit, offset) as ReactionRow[];
  },

  count(): number {
    const db = getConnection();
    const row = db.prepare('SELECT COUNT(*) as count FROM reactions').get() as { count: number };
    return row.count;
  },

  countByReaction(): Record<string, number> {
    const db = getConnection();
    const rows = db.prepare(
      'SELECT reaction, COUNT(*) as count FROM reactions GROUP BY reaction'
    ).all() as Array<{ reaction: string; count: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.reaction] = row.count;
    }
    return result;
  },
};
