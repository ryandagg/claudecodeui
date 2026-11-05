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

export type SessionMatchSearchParams = {
  /** Escaped via {@link toFtsMatchLiteral}. */
  matchLiteral: string;
  jsonlPaths?: readonly string[] | null;
  projectPaths?: { include?: readonly string[] | null; exclude?: readonly string[] | null } | null;
  roles?: readonly string[] | null;
  after?: string | null;
  before?: string | null;
  perSessionLimit: number;
  limit: number;
  offset?: number;
};

export type SessionMatchRow = SearchIndexHit & {
  /** 1-based rank of this row within its session. */
  session_rank: number;
  /** Best (lowest) bm25 of any row in the session. */
  session_best_rank: number;
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

  /**
   * Filtered, paginated session-grouped search. Every filter runs in SQL next
   * to the MATCH, so a filter that drops most hits can never starve a page
   * (unlike a fixed over-fetch + JS post-filter).
   *
   * Rows come back ordered by session (best bm25 hit first), then by rank
   * within the session, capped at `perSessionLimit` rows per session. A
   * session's rows are therefore contiguous, which lets callers cut pages on
   * session boundaries with plain LIMIT/OFFSET.
   *
   * Filter semantics (each `null`/omitted = no constraint):
   * - `jsonlPaths`: allowed transcript paths (normalized, as stored). `[]` = nothing.
   * - `projectPaths.include` / `.exclude`: exact `project_path` sets; exclude wins.
   * - `roles`: allowed message roles.
   * - `after` (inclusive) / `before` (exclusive): ISO instants vs message
   *   `timestamp`; rows without a timestamp are dropped when either is set.
   */
  searchSessionMatches(params: SessionMatchSearchParams): SessionMatchRow[] {
    const db = getConnection();
    const json = (value: readonly string[] | null | undefined) => (value ? JSON.stringify(value) : null);
    const include = params.projectPaths?.include;
    const exclude = params.projectPaths?.exclude;
    return db
      .prepare(
        `WITH hits AS (
           SELECT rowid AS rid, jsonl_path, seq, bm25(session_message_index) AS rank
           FROM session_message_index
           WHERE session_message_index MATCH @match
             AND (@paths IS NULL OR jsonl_path IN (SELECT value FROM json_each(@paths)))
             AND (@projectInclude IS NULL OR project_path IN (SELECT value FROM json_each(@projectInclude)))
             AND (@projectExclude IS NULL OR project_path IS NULL
                  OR project_path NOT IN (SELECT value FROM json_each(@projectExclude)))
             AND (@roles IS NULL OR role IN (SELECT value FROM json_each(@roles)))
             AND (@after IS NULL OR julianday(timestamp) >= julianday(@after))
             AND (@before IS NULL OR julianday(timestamp) < julianday(@before))
         ),
         ranked AS (
           SELECT rid, jsonl_path, seq, rank,
                  ROW_NUMBER() OVER (PARTITION BY jsonl_path ORDER BY rank, seq) AS session_rank,
                  MIN(rank) OVER (PARTITION BY jsonl_path) AS session_best_rank
           FROM hits
         )
         SELECT i.jsonl_path, i.project_path, i.role, i.timestamp, i.message_uuid, i.seq, i.body,
                r.rank, r.session_rank, r.session_best_rank
         FROM ranked r
         JOIN session_message_index i ON i.rowid = r.rid
         WHERE r.session_rank <= @perSessionLimit
         ORDER BY r.session_best_rank, r.jsonl_path, r.session_rank
         LIMIT @limit OFFSET @offset`,
      )
      .all({
        match: params.matchLiteral,
        paths: json(params.jsonlPaths),
        projectInclude: json(include),
        projectExclude: exclude && exclude.length > 0 ? json(exclude) : null,
        roles: params.roles && params.roles.length > 0 ? json(params.roles) : null,
        after: params.after ?? null,
        before: params.before ?? null,
        perSessionLimit: params.perSessionLimit,
        limit: params.limit,
        offset: params.offset ?? 0,
      }) as SessionMatchRow[];
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
