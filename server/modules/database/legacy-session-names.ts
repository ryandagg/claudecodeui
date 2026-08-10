import path from 'node:path';

import type { Database } from 'better-sqlite3';


import {
  appendSessionCustomTitle,
  buildLookupMap,
  getClaudeHome,
  readSessionTitleCandidates,
} from '@/shared/utils.js';

type LegacyNameRow = {
  session_id: string;
  provider_session_id: string | null;
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
              sessions.provider_session_id AS provider_session_id,
              legacy_session_names.custom_name AS custom_name,
              session_transcripts.jsonl_path AS jsonl_path
       FROM legacy_session_names
       LEFT JOIN session_transcripts
         ON session_transcripts.session_id = legacy_session_names.session_id
       LEFT JOIN sessions
         ON sessions.session_id = legacy_session_names.session_id`
    )
    .all() as LegacyNameRow[];

  const updateProviderName = db.prepare(
    'UPDATE session_transcripts SET provider_name = ? WHERE session_id = ?'
  );

  // history.jsonl records the raw first prompt, which the old synchronizer used
  // as a name. Read once rather than per row.
  const displayBySessionId = await buildLookupMap(
    path.join(getClaudeHome(), 'history.jsonl'),
    'sessionId',
    'display'
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

    // The decisive test: is this a name a person typed, or one the app
    // generated? The old synchronizer seeded custom_name from the first prompt,
    // an ai-title, or a last-prompt, so a stored value matching any of those is
    // not a rename and must not be written into the transcript. Prefix matching
    // covers the truncation the old code applied. Skipping costs nothing
    // visually — the sidebar falls back to the same string.
    const candidates = await readSessionTitleCandidates(row.jsonl_path);
    const displayValue = displayBySessionId.get(row.provider_session_id ?? row.session_id);
    if (displayValue) {
      candidates.add(displayValue.trim());
    }

    const wasGenerated = [...candidates].some(
      (candidate) => candidate === name || candidate.startsWith(name)
    );
    if (wasGenerated) {
      skipped += 1;
      continue;
    }

    // The provider's own id, not the app-facing one. Every other line in the
    // transcript carries the provider id, and a `custom-title` whose sessionId
    // disagrees with its siblings is exactly the portability this pass exists
    // to provide. Matches the live rename path in sessions.db.ts.
    const wrote = await appendSessionCustomTitle(
      row.jsonl_path,
      row.provider_session_id ?? row.session_id,
      name
    );
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
