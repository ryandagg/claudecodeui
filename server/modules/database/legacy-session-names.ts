import type { Database } from 'better-sqlite3';

import { appendSessionCustomTitle, readSessionTitle } from '@/shared/utils.js';

type LegacyNameRow = {
  session_id: string;
  custom_name: string;
  jsonl_path: string | null;
};

/**
 * Placeholder the old synchronizer wrote when it could find no title at all.
 */
const PLACEHOLDER_NAME = 'Untitled Claude Session';

/**
 * True for a value that was echoed from a slash command rather than chosen as
 * a name. `history.jsonl` records the raw prompt, so renaming with `/rename foo`
 * left the literal string `"/rename foo"` in the database. Writing that back as
 * a title would pin it above the real `custom-title` Claude already recorded.
 */
const isSlashCommandEcho = (name: string): boolean => name.trimStart().startsWith('/');

/**
 * Promotes names set in the app before renames became portable.
 *
 * Those names existed only in `sessions.custom_name` — the old rename wrote to
 * the database and nothing else — so once the column is retired there is
 * nothing to derive them from and a deliberately chosen name would silently
 * revert to a generated title. Writing each one into its transcript as a
 * `custom-title` line preserves it *and* upgrades it: it becomes the
 * top-precedence title, survives any rebuild of derived data, and shows up in
 * `claude --resume` like a rename made today.
 *
 * Runs once. `legacy_session_names` is populated by the split migration and
 * dropped here, so a second call is a no-op.
 */
export async function flushLegacySessionNamesToTranscripts(db: Database): Promise<void> {
  const tableExists = Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legacy_session_names'")
      .get()
  );

  if (!tableExists) {
    return;
  }

  const rows = db
    .prepare(
      `SELECT legacy_session_names.session_id AS session_id,
              legacy_session_names.custom_name AS custom_name,
              session_transcripts.jsonl_path AS jsonl_path
       FROM legacy_session_names
       LEFT JOIN session_transcripts
         ON session_transcripts.session_id = legacy_session_names.session_id`
    )
    .all() as LegacyNameRow[];

  const updateProviderName = db.prepare(
    'UPDATE session_transcripts SET provider_name = ? WHERE session_id = ?'
  );

  let promoted = 0;
  let skipped = 0;

  for (const row of rows) {
    const name = row.custom_name.trim();

    // Nothing worth preserving: a placeholder, a slash command echo, or no
    // transcript to write into.
    if (!name || name === PLACEHOLDER_NAME || isSlashCommandEcho(name) || !row.jsonl_path) {
      skipped += 1;
      continue;
    }

    // Already recoverable from the transcript — writing it again would only add
    // a redundant line to a file this app does not own.
    const derivedTitle = await readSessionTitle(row.jsonl_path);
    if (derivedTitle === name) {
      skipped += 1;
      continue;
    }

    const wrote = await appendSessionCustomTitle(row.jsonl_path, row.session_id, name);
    if (!wrote) {
      skipped += 1;
      continue;
    }

    updateProviderName.run(name, row.session_id);
    promoted += 1;
  }

  db.exec('DROP TABLE legacy_session_names');

  if (promoted > 0 || skipped > 0) {
    console.log(
      `Running migration: Promoted ${promoted} app-set session name(s) into their transcripts (${skipped} skipped)`
    );
  }
}
