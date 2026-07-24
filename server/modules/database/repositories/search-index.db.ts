import { getConnection } from '@/modules/database/connection.js';

/**
 * Repository for the FTS5 message index (`session_message_index`) and its
 * per-file incremental cursor (`session_index_files`).
 *
 * Rows are keyed by `jsonl_path` (the transcript file), so the app/provider
 * session-id merge never orphans index rows. Text search uses the trigram
 * tokenizer for case-insensitive substring matching; see schema.ts.
 */

export type IndexableMessage = {
  role: string;
  text: string;
  timestamp: string | null;
  messageUuid: string | null;
  seq: number;
};

export type SearchIndexHit = {
  jsonl_path: string;
  project_path: string | null;
  role: string;
  timestamp: string | null;
  message_uuid: string | null;
  seq: number;
  body: string;
  rank: number;
};

export type FileCursor = {
  indexed_bytes: number;
  file_size: number;
};

/**
 * Escapes an arbitrary user string into a single FTS5 string literal so it is
 * matched verbatim as a substring rather than parsed as query syntax.
 *
 * Raw FTS5 `MATCH` input treats `-`, `*`, `:`, `"`, `(`, `AND/OR/NOT`, and bare
 * tokens as operators — e.g. `rm -rf` throws "no such column: rf". Wrapping the
 * whole query in double quotes (with internal quotes doubled) turns it into one
 * quoted string that trigram matches as a contiguous, case-insensitive
 * substring — the grep-like behavior users expect.
 */
export function toFtsMatchLiteral(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

export const searchIndexDb = {
  /**
   * Replaces all indexed rows for a file (delete + re-insert) and resets the
   * file cursor. Used for backfill and for the shrink/rewrite re-index path.
   *
   * `indexedBytes` is the count of fully-parsed (newline-terminated) bytes and
   * may be less than `fileSize` when the file ends mid-line; `fileSize` is the
   * real on-disk size used for shrink detection.
   */
  replaceFileMessages(
    jsonlPath: string,
    projectPath: string | null,
    messages: IndexableMessage[],
    indexedBytes: number,
    fileSize: number,
  ): void {
    const db = getConnection();
    const deleteRows = db.prepare('DELETE FROM session_message_index WHERE jsonl_path = ?');
    const insertRow = db.prepare(
      `INSERT INTO session_message_index
         (jsonl_path, project_path, role, timestamp, message_uuid, seq, body)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const upsertCursor = db.prepare(
      `INSERT INTO session_index_files (jsonl_path, project_path, indexed_bytes, file_size, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(jsonl_path) DO UPDATE SET
         project_path = excluded.project_path,
         indexed_bytes = excluded.indexed_bytes,
         file_size = excluded.file_size,
         updated_at = CURRENT_TIMESTAMP`,
    );

    const run = db.transaction((rows: IndexableMessage[]) => {
      deleteRows.run(jsonlPath);
      for (const message of rows) {
        insertRow.run(
          jsonlPath,
          projectPath,
          message.role,
          message.timestamp,
          message.messageUuid,
          message.seq,
          message.text,
        );
      }
      upsertCursor.run(jsonlPath, projectPath, indexedBytes, fileSize);
    });

    run(messages);
  },

  /**
   * Appends newly-parsed rows for a growing file and advances the cursor.
   * Insert-only — assumes the transcript is append-only and existing rows for
   * this file are still valid.
   */
  appendFileMessages(
    jsonlPath: string,
    projectPath: string | null,
    messages: IndexableMessage[],
    indexedBytes: number,
    fileSize: number,
  ): void {
    const db = getConnection();
    const insertRow = db.prepare(
      `INSERT INTO session_message_index
         (jsonl_path, project_path, role, timestamp, message_uuid, seq, body)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const upsertCursor = db.prepare(
      `INSERT INTO session_index_files (jsonl_path, project_path, indexed_bytes, file_size, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(jsonl_path) DO UPDATE SET
         project_path = excluded.project_path,
         indexed_bytes = excluded.indexed_bytes,
         file_size = excluded.file_size,
         updated_at = CURRENT_TIMESTAMP`,
    );

    const run = db.transaction((rows: IndexableMessage[]) => {
      for (const message of rows) {
        insertRow.run(
          jsonlPath,
          projectPath,
          message.role,
          message.timestamp,
          message.messageUuid,
          message.seq,
          message.text,
        );
      }
      upsertCursor.run(jsonlPath, projectPath, indexedBytes, fileSize);
    });

    run(messages);
  },

  getFileCursor(jsonlPath: string): FileCursor | null {
    const db = getConnection();
    const row = db
      .prepare('SELECT indexed_bytes, file_size FROM session_index_files WHERE jsonl_path = ?')
      .get(jsonlPath) as FileCursor | undefined;
    return row ?? null;
  },

  deleteByJsonlPath(jsonlPath: string): void {
    const db = getConnection();
    const run = db.transaction(() => {
      db.prepare('DELETE FROM session_message_index WHERE jsonl_path = ?').run(jsonlPath);
      db.prepare('DELETE FROM session_index_files WHERE jsonl_path = ?').run(jsonlPath);
    });
    run();
  },

  deleteByProjectPath(projectPath: string): void {
    const db = getConnection();
    const run = db.transaction(() => {
      db.prepare('DELETE FROM session_message_index WHERE project_path = ?').run(projectPath);
      db.prepare('DELETE FROM session_index_files WHERE project_path = ?').run(projectPath);
    });
    run();
  },

  /**
   * Runs a trigram MATCH ordered by bm25 relevance. `matchLiteral` must already
   * be escaped via {@link toFtsMatchLiteral}.
   */
  search(matchLiteral: string, limit: number): SearchIndexHit[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT jsonl_path, project_path, role, timestamp, message_uuid, seq, body,
                bm25(session_message_index) AS rank
         FROM session_message_index
         WHERE session_message_index MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(matchLiteral, limit) as SearchIndexHit[];
  },

  countIndexedFiles(): number {
    const db = getConnection();
    const row = db.prepare('SELECT COUNT(*) AS count FROM session_index_files').get() as { count: number };
    return Number(row?.count ?? 0);
  },

  clearAll(): void {
    const db = getConnection();
    const run = db.transaction(() => {
      db.prepare('DELETE FROM session_message_index').run();
      db.prepare('DELETE FROM session_index_files').run();
    });
    run();
  },
};
