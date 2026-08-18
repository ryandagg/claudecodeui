const USER_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT 1,
    git_name TEXT,
    git_email TEXT,
    has_completed_onboarding BOOLEAN DEFAULT 0
);
`;

export const API_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_name TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used DATETIME,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_CREDENTIALS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_name TEXT NOT NULL,
    credential_type TEXT NOT NULL, -- 'github_token', 'gitlab_token', 'bitbucket_token', etc.
    credential_value TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id INTEGER PRIMARY KEY,
    preferences_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const VAPID_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vapid_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notification_channel_endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    endpoint_id TEXT NOT NULL,
    label TEXT,
    metadata_json TEXT,
    enabled BOOLEAN DEFAULT 1,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, channel, endpoint_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const PROJECTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY NOT NULL,
    project_path TEXT NOT NULL UNIQUE,
    custom_project_name TEXT DEFAULT NULL,
    isStarred BOOLEAN DEFAULT 0,
    isArchived BOOLEAN DEFAULT 0
);
`;

/**
 * Session identity and app-owned metadata.
 *
 * Every column here either identifies the session or exists nowhere else:
 * `isArchived` and `starred_at` cannot be recovered from the provider's
 * transcripts. Synchronizers may insert identity rows but must never update
 * this table, so re-deriving from disk cannot destroy user state. Anything
 * reconstructible from a transcript belongs in `session_transcripts` —
 * including renames, which are written to the transcript as `custom-title`
 * so they stay visible to Claude's own CLI.
 */
export const SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'claude',
    -- The session id used by the provider CLI/SDK on disk (JSONL file name,
    -- store.db folder, sqlite row id, ...). \`session_id\` is the stable
    -- app-facing id that the frontend uses for the whole session lifetime;
    -- \`provider_session_id\` is filled in once the provider announces its own
    -- id mid-run, or equals \`session_id\` for sessions discovered on disk.
    -- It stays here rather than in session_transcripts because a live run
    -- announces it before any transcript exists, and rebuilding derived data
    -- must not disturb that mapping.
    provider_session_id TEXT,
    project_path TEXT,
    isArchived BOOLEAN DEFAULT 0,
    starred_at DATETIME DEFAULT NULL,
    -- When the app first learned of this session, not when the conversation
    -- started; the transcript is authoritative for the latter.
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id),
    FOREIGN KEY (project_path) REFERENCES projects(project_path)
    ON DELETE SET NULL
    ON UPDATE CASCADE
);
`;

/**
 * Everything about a session that is derived from its transcript on disk.
 *
 * This table is disposable by design: `DELETE FROM session_transcripts` followed
 * by a full re-scan must reproduce it exactly, leaving app-owned state in
 * `sessions` untouched. The foreign key deliberately cascades one way only —
 * deleting a session drops its derived row, but clearing derived rows never
 * reaches back into `sessions`.
 */
export const SESSION_TRANSCRIPTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_transcripts (
    session_id TEXT PRIMARY KEY NOT NULL,
    jsonl_path TEXT,
    -- Best title the transcript carries: the user's /rename (custom-title)
    -- outranks an ai-title, which outranks raw prompt text. Derived, so a
    -- rename made in Claude's CLI shows up here on the next sync.
    provider_name TEXT,
    -- Timestamps of the first and last messages in the transcript. Never file
    -- mtime: touching a file must not make a stale conversation look active.
    first_message_at DATETIME,
    last_message_at DATETIME,
    indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
`;

/**
 * Read-side composition of the two tables, presenting the pre-split column set.
 *
 * Readers select from here; writers must target `sessions` or
 * `session_transcripts` explicitly. SQLite views are not writable, so a write
 * aimed at the old shape fails loudly instead of silently clobbering owned
 * state — the un-archive bug is unexpressible rather than merely fixed.
 */
export const SESSION_ROWS_VIEW_SQL = `
CREATE VIEW IF NOT EXISTS session_rows AS
SELECT
    sessions.session_id,
    sessions.provider,
    sessions.provider_session_id,
    session_transcripts.provider_name AS custom_name,
    sessions.project_path,
    session_transcripts.jsonl_path AS jsonl_path,
    sessions.isArchived,
    sessions.starred_at,
    COALESCE(session_transcripts.first_message_at, sessions.created_at) AS created_at,
    COALESCE(session_transcripts.last_message_at, sessions.created_at) AS updated_at
FROM sessions
LEFT JOIN session_transcripts ON session_transcripts.session_id = sessions.session_id;
`;

export const LAST_SCANNED_AT_SQL = `
CREATE TABLE IF NOT EXISTS scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_at TIMESTAMP NULL
);
`;

export const APP_CONFIG_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const USER_SETTINGS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const REACTIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    message_index INTEGER NOT NULL,
    message_role TEXT NOT NULL,
    message_content TEXT,
    reaction TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

// Full-text search over session-transcript messages.
//
// Uses the FTS5 `trigram` tokenizer, which indexes every 3-character sequence
// so `MATCH` behaves like a case-insensitive substring (grep-style) search:
// searching `config` finds `configuration` and `reconfigure`. This replaces the
// previous ripgrep-per-query scan of the raw JSONL files. Trigram requires a
// query of at least 3 characters.
//
// Rows are keyed by `jsonl_path` (the transcript file), not `session_id`, so
// the mid-run app/provider session merge (which can delete or re-key a
// session_id while the file path is stable) never orphans index rows. The
// UNINDEXED columns are stored-but-not-tokenized metadata used to rebuild
// results without re-reading the transcript on disk.
export const SESSION_MESSAGE_INDEX_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS session_message_index USING fts5(
    jsonl_path UNINDEXED,
    project_path UNINDEXED,
    role UNINDEXED,
    timestamp UNINDEXED,
    message_uuid UNINDEXED,
    seq UNINDEXED,
    body,
    tokenize = 'trigram'
);
`;

// Per-file incremental cursor for the message index. `indexed_bytes` records
// how many bytes of the append-only transcript have already been indexed, so
// the watcher only reads and indexes newly appended lines. `file_size` lets a
// shrink/rewrite be detected and trigger a full re-index of that file.
export const SESSION_INDEX_FILES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_index_files (
    jsonl_path TEXT PRIMARY KEY,
    project_path TEXT,
    indexed_bytes INTEGER NOT NULL DEFAULT 0,
    file_size INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const INIT_SCHEMA_SQL = `
-- Initialize authentication database
PRAGMA foreign_keys = ON;

${USER_TABLE_SCHEMA_SQL}
-- Indexes for performance for user lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

${API_KEYS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

${USER_CREDENTIALS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credentials_type ON user_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_user_credentials_active ON user_credentials(is_active);

${USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_notification_preferences_user_id ON user_notification_preferences(user_id);

${VAPID_KEYS_TABLE_SCHEMA_SQL}

${PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

${NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_user_channel ON notification_channel_endpoints(user_id, channel);
CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_enabled ON notification_channel_endpoints(enabled);

${PROJECTS_TABLE_SCHEMA_SQL}
-- NOTE: These indexes are created in migrations after legacy table-shape repairs.
-- Creating them here can fail on upgraded installs where projects lacks those columns.

${SESSIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id);
-- NOTE: This index is created in migrations after sessions is rebuilt to include project_path.
-- Creating it here can fail on upgraded installs where the legacy sessions table has no project_path.

${SESSION_TRANSCRIPTS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_session_transcripts_last_message ON session_transcripts(last_message_at);
CREATE INDEX IF NOT EXISTS idx_session_transcripts_jsonl_path ON session_transcripts(jsonl_path);
-- NOTE: The session_rows view is created in migrations, after the legacy
-- sessions table has been split; creating it here would fail on upgraded
-- installs where session_transcripts does not exist yet.

${LAST_SCANNED_AT_SQL}

${APP_CONFIG_TABLE_SCHEMA_SQL}

${REACTIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_reactions_session ON reactions(session_id);
CREATE INDEX IF NOT EXISTS idx_reactions_created ON reactions(created_at);

${USER_SETTINGS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_settings_user_id ON user_settings(user_id);

${SESSION_MESSAGE_INDEX_SCHEMA_SQL}

${SESSION_INDEX_FILES_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_session_index_files_project ON session_index_files(project_path);
`;
