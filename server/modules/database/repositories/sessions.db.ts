import path from 'node:path';

import { getConnection } from '@/modules/database/connection.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { searchIndexDb } from '@/modules/database/repositories/search-index.db.js';
import { appendSessionCustomTitle, normalizeProjectPath } from '@/shared/utils.js';

type SessionRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
  jsonl_path: string | null;
  custom_name: string | null;
  isArchived: number;
  starred_at: string | null;
  created_at: string;
  updated_at: string;
};

const SESSION_ROW_COLUMNS =
  'session_id, provider, provider_session_id, project_path, jsonl_path, custom_name, isArchived, starred_at, created_at, updated_at';

const SQLITE_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function normalizeTimestamp(value?: string): string | null {
  if (!value) return null;

  // SQLite CURRENT_TIMESTAMP is stored as UTC without a timezone suffix.
  // Normalize it here so every session reader returns canonical ISO strings
  // and the sidebar never interprets fresh rows as local-time "hours old".
  const normalizedValue = SQLITE_UTC_TIMESTAMP_REGEX.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;

  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function normalizeSessionRow<T extends SessionRow | null | undefined>(row: T): T {
  if (!row) {
    return row;
  }

  return {
    ...row,
    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,
    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,
  };
}

function normalizeSessionRows(rows: SessionRow[]): SessionRow[] {
  return rows.map((row) => normalizeSessionRow(row) as SessionRow);
}

function normalizeProjectPathForProvider(provider: string, projectPath: string): string {
  void provider;
  return normalizeProjectPath(projectPath);
}

export const sessionsDb = {
  /**
   * Upserts one session row discovered on disk by a provider synchronizer.
   *
   * The given id is the provider-native session id. Rows are keyed by
   * `provider_session_id` so a session that was first created by the app
   * (with an app-allocated `session_id`) is updated in place once its
   * transcript shows up on disk, instead of producing a duplicate row.
   */
  createSession(
    providerSessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
    createdAt?: string,
    updatedAt?: string,
    jsonlPath?: string | null
  ): string {
    const db = getConnection();
    const createdAtValue = normalizeTimestamp(createdAt);
    const updatedAtValue = normalizeTimestamp(updatedAt);
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    // Passive discovery must never reactivate a project the user archived,
    // so this is the ensure variant rather than the user-facing create.
    projectsDb.ensureProjectPath(normalizedProjectPath);

    const existing = db
      .prepare(
        `SELECT session_id FROM sessions
         WHERE provider_session_id = ? AND provider = ?
         LIMIT 1`
      )
      .get(providerSessionId, provider) as { session_id: string } | undefined;

    const sessionId = existing?.session_id ?? providerSessionId;

    // Identity only. `custom_name`, `isArchived` and `starred_at` are owned by
    // the user and exist nowhere on disk, so no synchronizer statement may
    // write them — re-deriving from a transcript cannot clobber them. The
    // provider's own title is derived and lands in session_transcripts.
    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, project_path, created_at)
       VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
       ON CONFLICT(session_id) DO UPDATE SET
         provider = excluded.provider,
         provider_session_id = excluded.provider_session_id,
         project_path = excluded.project_path`
    ).run(
      sessionId,
      provider,
      providerSessionId,
      normalizedProjectPath,
      createdAtValue
    );

    sessionsDb.upsertSessionTranscript(sessionId, {
      providerName: customName ?? null,
      jsonlPath: jsonlPath ?? null,
      firstMessageAt: createdAtValue,
      lastMessageAt: updatedAtValue,
    });

    return sessionId;
  },

  /**
   * Records transcript-derived facts for one session.
   *
   * Everything written here is reconstructible from the file on disk, so this
   * table can be emptied and rebuilt at will. Callers pass timestamps taken
   * from message content; file mtime is not a valid source.
   */
  upsertSessionTranscript(
    sessionId: string,
    transcript: {
      providerName?: string | null;
      jsonlPath?: string | null;
      firstMessageAt?: string | null;
      lastMessageAt?: string | null;
    }
  ): void {
    const db = getConnection();

    db.prepare(
      `INSERT INTO session_transcripts (session_id, provider_name, jsonl_path, first_message_at, last_message_at, indexed_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(session_id) DO UPDATE SET
         provider_name = COALESCE(excluded.provider_name, session_transcripts.provider_name),
         jsonl_path = COALESCE(excluded.jsonl_path, session_transcripts.jsonl_path),
         first_message_at = COALESCE(excluded.first_message_at, session_transcripts.first_message_at),
         last_message_at = COALESCE(excluded.last_message_at, session_transcripts.last_message_at),
         indexed_at = CURRENT_TIMESTAMP`
    ).run(
      sessionId,
      transcript.providerName ?? null,
      transcript.jsonlPath ?? null,
      normalizeTimestamp(transcript.firstMessageAt ?? undefined),
      normalizeTimestamp(transcript.lastMessageAt ?? undefined)
    );
  },

  /**
   * Inserts one app-allocated session row before any provider run happens.
   *
   * The session gateway uses this when the frontend starts a brand-new chat:
   * `session_id` is the stable app-facing id, while `provider_session_id`
   * stays NULL until the provider runtime announces its own id and
   * `assignProviderSessionId` records the mapping.
   */
  createAppSession(sessionId: string, provider: string, projectPath: string): string {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    projectsDb.ensureProjectPath(normalizedProjectPath);

    // No transcript row yet — one appears once the provider writes the file.
    // Until then `session_rows` falls back to created_at for ordering.
    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, project_path, isArchived, created_at)
       VALUES (?, ?, NULL, ?, 0, CURRENT_TIMESTAMP)`
    ).run(sessionId, provider, normalizedProjectPath);

    return sessionId;
  },

  /**
   * Records the provider-native session id for one app-allocated session.
   *
   * If the filesystem watcher indexed the provider transcript before this
   * mapping was recorded (a duplicate row keyed by the provider id exists),
   * the duplicate is merged into the app row: its transcript path and name
   * are adopted and the duplicate row is removed. Runs in a transaction so
   * the sidebar can never observe both rows at once.
   */
  assignProviderSessionId(sessionId: string, providerSessionId: string): void {
    const db = getConnection();

    const merge = db.transaction(() => {
      const duplicate = db
        .prepare(
          `SELECT ${SESSION_ROW_COLUMNS} FROM session_rows
           WHERE (session_id = ? OR provider_session_id = ?)
             AND session_id <> ?
           LIMIT 1`
        )
        .get(providerSessionId, providerSessionId, sessionId) as SessionRow | undefined;

      if (duplicate) {
        // Deleting the duplicate cascades to its transcript row, so adopt the
        // derived facts onto the surviving app row first.
        const duplicateTranscript = db
          .prepare(
            `SELECT first_message_at, last_message_at FROM session_transcripts WHERE session_id = ?`
          )
          .get(duplicate.session_id) as
          | { first_message_at: string | null; last_message_at: string | null }
          | undefined;

        db.prepare('DELETE FROM sessions WHERE session_id = ?').run(duplicate.session_id);
        db.prepare('UPDATE sessions SET provider_session_id = ? WHERE session_id = ?')
          .run(providerSessionId, sessionId);

        sessionsDb.upsertSessionTranscript(sessionId, {
          providerName: duplicate.custom_name,
          jsonlPath: duplicate.jsonl_path,
          firstMessageAt: duplicateTranscript?.first_message_at ?? null,
          lastMessageAt: duplicateTranscript?.last_message_at ?? null,
        });
        return;
      }

      db.prepare(
        `UPDATE sessions SET provider_session_id = ? WHERE session_id = ?`
      ).run(providerSessionId, sessionId);
    });

    merge();
  },

  /**
   * Renames a session by writing a `custom-title` line into its transcript.
   *
   * The transcript is the only home for a rename. Written there it is portable
   * — `claude --resume` shows it, it survives any rebuild of derived data, and
   * a rename made by Claude's own `/rename` is the same fact in the same
   * place, so the two can never disagree. `provider_name` is updated in step
   * so the UI reflects the change without waiting for the next sync.
   *
   * Returns false when the session has no transcript to write to; callers
   * surface that rather than storing the name somewhere it cannot be seen
   * from outside this app.
   */
  async updateSessionCustomName(sessionId: string, customName: string): Promise<boolean> {
    const db = getConnection();
    const trimmedName = customName.trim();

    const session = db
      .prepare(
        `SELECT session_transcripts.jsonl_path AS jsonl_path,
                sessions.provider_session_id AS provider_session_id
         FROM sessions
         LEFT JOIN session_transcripts ON session_transcripts.session_id = sessions.session_id
         WHERE sessions.session_id = ?`
      )
      .get(sessionId) as
      | { jsonl_path: string | null; provider_session_id: string | null }
      | undefined;

    if (!session?.jsonl_path) {
      return false;
    }

    const wroteToTranscript = await appendSessionCustomTitle(
      session.jsonl_path,
      session.provider_session_id ?? sessionId,
      trimmedName
    );

    if (!wroteToTranscript) {
      return false;
    }

    db.prepare('UPDATE session_transcripts SET provider_name = ? WHERE session_id = ?')
      .run(trimmedName, sessionId);

    return true;
  },

  getSessionById(sessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM session_rows
         WHERE session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(sessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Resolves one session row through the provider-native id.
   *
   * The filesystem watcher only knows provider ids (they come from transcript
   * file names), so it uses this lookup to translate disk artifacts back to
   * the app-facing session row before broadcasting sidebar updates.
   */
  getSessionByProviderSessionId(providerSessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM session_rows
         WHERE provider_session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(providerSessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Finds the newest app-created session for a project that is still waiting
   * for its provider-native id to be recorded.
   *
   * Primary intention: OpenCode can expose a new session in its shared
   * `opencode.db` before the websocket runtime reports that same provider id
   * back to our app. At that moment the sidebar already has an optimistic
   * app-owned session row, but the watcher only knows the provider-native id.
   *
   * Without this lookup, the synchronizer would insert a second row keyed by
   * the provider id, then `assignProviderSessionId()` would merge it a moment
   * later. That eventually self-heals, but on slow networks the user can still
   * briefly see two sidebar sessions for the same conversation.
   *
   * This helper lets the synchronizer claim the pending app row first, so the
   * provider id is attached before any watcher-created row exists. The result
   * is simpler than frontend dedupe and keeps the race resolved at the source.
   */
  findLatestPendingAppSession(provider: string, projectPath: string): SessionRow | null {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM session_rows
         WHERE provider = ?
           AND project_path = ?
           AND provider_session_id IS NULL
           AND isArchived = 0
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT 1`
      )
      .get(provider, normalizedProjectPath) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  getAllSessions(): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM session_rows
         WHERE isArchived = 0`
      )
      .all() as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Every session row, archived or not.
   *
   * Search is the intended caller: archiving hides a session from the active
   * sidebar list, but its transcript is still the user's history, so content
   * search must be able to index and find it. Active-list readers should keep
   * using `getAllSessions()`.
   */
  getAllSessionsIncludingArchived(): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(`SELECT ${SESSION_ROW_COLUMNS} FROM session_rows`)
      .all() as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Archived rows are intentionally queried separately so the caller can render
   * them in a dedicated view without reintroducing them into active session lists.
   */
  getArchivedSessions(): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM session_rows
         WHERE isArchived = 1
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC`
      )
      .all() as SessionRow[];

    return normalizeSessionRows(rows);
  },

  getSessionsByProjectPath(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM session_rows
         WHERE project_path = ?
           AND isArchived = 0`
      )
      .all(normalizedProjectPath) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Permanent project deletion must see every session row for the path,
   * including archived ones, so their transcript files can be cleaned up.
   */
  getSessionsByProjectPathIncludingArchived(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM session_rows
         WHERE project_path = ?`
      )
      .all(normalizedProjectPath) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  getSessionsByProjectPathPage(projectPath: string, limit: number, offset: number): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM session_rows
         WHERE project_path = ?
           AND isArchived = 0
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(normalizedProjectPath, limit, offset) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  countSessionsByProjectPath(projectPath: string): number {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM session_rows
         WHERE project_path = ?
           AND isArchived = 0`
      )
      .get(normalizedProjectPath) as { count: number } | undefined;

    return Number(row?.count ?? 0);
  },

  deleteSessionsByProjectPath(projectPath: string): void {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    db.prepare(`DELETE FROM sessions WHERE project_path = ?`).run(normalizedProjectPath);
    // Mirror the deletion into the search index so a removed project's
    // transcripts stop surfacing in conversation search.
    searchIndexDb.deleteByProjectPath(normalizedProjectPath);
  },

  getSessionName(sessionId: string, provider: string): string | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT custom_name
         FROM session_rows
         WHERE session_id = ? AND provider = ?`
      )
      .get(sessionId, provider) as { custom_name: string | null } | undefined;

    return row?.custom_name ?? null;
  },

  /**
   * Soft-delete and restore both use the same flag update so callers keep the
   * row, metadata, and file path intact while toggling visibility.
   */
  updateSessionIsArchived(sessionId: string, isArchived: boolean): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET isArchived = ?
       WHERE session_id = ?`
    ).run(isArchived ? 1 : 0, sessionId);
  },

  deleteSessionById(sessionId: string): boolean {
    const db = getConnection();

    // Capture the transcript path before deleting so its index rows can be
    // mirrored out. Read first: after the DELETE the row is gone.
    const row = db
      .prepare('SELECT jsonl_path FROM session_rows WHERE session_id = ?')
      .get(sessionId) as { jsonl_path: string | null } | undefined;

    const deleted = db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId).changes > 0;

    const rawJsonlPath = typeof row?.jsonl_path === 'string' ? row.jsonl_path.trim() : '';
    if (deleted && rawJsonlPath) {
      // A transcript path can be shared by more than one session row (e.g. an
      // app row and a provider row mid-merge). Only purge the index when no
      // other session still references the file, so a delete of one row never
      // blinds search for its sibling.
      const stillReferenced = db
        .prepare('SELECT 1 FROM session_rows WHERE jsonl_path = ? LIMIT 1')
        .get(rawJsonlPath) as { 1: number } | undefined;
      if (!stillReferenced) {
        searchIndexDb.deleteByJsonlPath(path.resolve(rawJsonlPath));
      }
    }

    return deleted;
  },

  /**
   * Toggles the star/pin state for a session. Returns the new starred state.
   * Starred sessions bubble to the top of the Conversations view via starred_at sort.
   */
  toggleSessionStar(sessionId: string): boolean {
    const db = getConnection();
    const current = db
      .prepare('SELECT starred_at FROM sessions WHERE session_id = ?')
      .get(sessionId) as { starred_at: string | null } | undefined;

    if (!current) {
      return false;
    }

    const newStarredState = current.starred_at === null;
    db.prepare(
      `UPDATE sessions
       SET starred_at = ?
       WHERE session_id = ?`
    ).run(newStarredState ? new Date().toISOString() : null, sessionId);

    return newStarredState;
  },
};
