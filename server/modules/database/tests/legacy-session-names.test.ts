import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { flushLegacySessionNamesToTranscripts } from '@/modules/database/legacy-session-names.js';
import { readSessionTitle } from '@/shared/utils.js';

/**
 * The promotion pass appends to real transcript files, so every test runs with
 * both the database *and* the provider home redirected into a temp tree.
 * `CLAUDE_HOME` is what makes that possible — without it these tests would
 * write the developer's own transcripts.
 */
async function withIsolatedEnvironment(
  runTest: (context: { claudeHome: string }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousClaudeHome = process.env.CLAUDE_HOME;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'legacy-names-'));
  const claudeHome = path.join(tempDirectory, 'claude-home');
  await mkdir(path.join(claudeHome, 'projects'), { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.CLAUDE_HOME = claudeHome;
  await initializeDatabase();

  try {
    await runTest({ claudeHome });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousClaudeHome === undefined) delete process.env.CLAUDE_HOME;
    else process.env.CLAUDE_HOME = previousClaudeHome;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Seeds one session plus the legacy-name row the split migration would leave. */
async function seedLegacySession(options: {
  claudeHome: string;
  sessionId: string;
  legacyName: string;
  transcriptLines?: unknown[];
  withTranscript?: boolean;
}): Promise<string | null> {
  const db = getConnection();
  const { claudeHome, sessionId, legacyName, transcriptLines = [], withTranscript = true } = options;

  db.prepare("INSERT OR IGNORE INTO projects (project_id, project_path) VALUES (?, '/tmp/demo')")
    .run(`project-${sessionId}`);
  db.prepare(
    `INSERT INTO sessions (session_id, provider, provider_session_id, project_path)
     VALUES (?, 'claude', ?, '/tmp/demo')`,
  ).run(sessionId, sessionId);

  let transcriptPath: string | null = null;
  if (withTranscript) {
    transcriptPath = path.join(claudeHome, 'projects', `${sessionId}.jsonl`);
    const body = transcriptLines.map((line) => JSON.stringify(line)).join('\n');
    await writeFile(transcriptPath, body ? `${body}\n` : '', 'utf8');
  }

  db.prepare('INSERT INTO session_transcripts (session_id, jsonl_path) VALUES (?, ?)')
    .run(sessionId, transcriptPath);

  db.exec(`CREATE TABLE IF NOT EXISTS legacy_session_names (
    session_id TEXT PRIMARY KEY NOT NULL, custom_name TEXT NOT NULL)`);
  db.prepare('INSERT INTO legacy_session_names (session_id, custom_name) VALUES (?, ?)')
    .run(sessionId, legacyName);

  return transcriptPath;
}

const legacyTableExists = (): boolean =>
  Boolean(
    getConnection()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='legacy_session_names'")
      .get(),
  );

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
test('promotes an app-set name into the transcript and the derived row', async () => {
  await withIsolatedEnvironment(async ({ claudeHome }) => {
    const transcriptPath = await seedLegacySession({
      claudeHome,
      sessionId: 'promote-me',
      legacyName: 'my curated name',
      transcriptLines: [{ type: 'ai-title', aiTitle: 'Generated Title' }],
    });

    await flushLegacySessionNamesToTranscripts(getConnection());

    // Durable: readable straight back out of the transcript, outranking ai-title.
    assert.equal(await readSessionTitle(transcriptPath as string), 'my curated name');
    // And reflected immediately, without waiting for a sync.
    const row = getConnection()
      .prepare("SELECT custom_name FROM session_rows WHERE session_id = 'promote-me'")
      .get() as { custom_name: string | null };
    assert.equal(row.custom_name, 'my curated name');
  });
});

test('writes the provider session id, not the app-facing one', async () => {
  // Every other line in a transcript carries the provider's id. A custom-title
  // whose sessionId disagrees with its siblings is exactly the portability this
  // pass exists to provide, so an app-created session (app id != provider id)
  // must still write the provider id.
  await withIsolatedEnvironment(async ({ claudeHome }) => {
    const db = getConnection();
    const transcriptPath = path.join(claudeHome, 'projects', 'provider-id.jsonl');
    await writeFile(transcriptPath, '', 'utf8');

    db.prepare("INSERT OR IGNORE INTO projects (project_id, project_path) VALUES ('p','/tmp/demo')").run();
    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, project_path)
       VALUES ('app-allocated-id', 'claude', 'provider-native-id', '/tmp/demo')`,
    ).run();
    db.prepare("INSERT INTO session_transcripts (session_id, jsonl_path) VALUES ('app-allocated-id', ?)")
      .run(transcriptPath);
    db.exec(`CREATE TABLE IF NOT EXISTS legacy_session_names (
      session_id TEXT PRIMARY KEY NOT NULL, custom_name TEXT NOT NULL)`);
    db.prepare("INSERT INTO legacy_session_names VALUES ('app-allocated-id', 'a chosen name')").run();

    await flushLegacySessionNamesToTranscripts(db);

    const written = JSON.parse((await readFile(transcriptPath, 'utf8')).trim());
    assert.equal(written.customTitle, 'a chosen name');
    assert.equal(written.sessionId, 'provider-native-id');
  });
});

test('leaves the transcript as valid JSONL', async () => {
  await withIsolatedEnvironment(async ({ claudeHome }) => {
    const transcriptPath = await seedLegacySession({
      claudeHome,
      sessionId: 'still-valid',
      legacyName: 'a name',
      transcriptLines: [{ type: 'user', text: 'hello' }, { type: 'assistant', text: 'hi' }],
    });

    await flushLegacySessionNamesToTranscripts(getConnection());

    const contents = await readFile(transcriptPath as string, 'utf8');
    for (const line of contents.trim().split('\n')) {
      JSON.parse(line);
    }
  });
});

// ---------------------------------------------------------------------------
// Skip rules — each asserts the transcript is byte-for-byte untouched, since a
// write here is permanent and lands in a file this app does not own.
// ---------------------------------------------------------------------------
const skipCases: Array<{ label: string; legacyName: string; transcriptLines: unknown[] }> = [
  {
    label: 'a blank name',
    legacyName: '   ',
    transcriptLines: [{ type: 'user', text: 'hi' }],
  },
  {
    label: 'the Untitled placeholder',
    legacyName: 'Untitled Claude Session',
    transcriptLines: [{ type: 'user', text: 'hi' }],
  },
  {
    label: 'a slash-command echo from history.jsonl',
    legacyName: '/rename something',
    transcriptLines: [{ type: 'custom-title', customTitle: 'something', sessionId: 'skip-me' }],
  },
  {
    label: 'a name already recoverable from the transcript',
    legacyName: 'Already Derived',
    transcriptLines: [{ type: 'ai-title', aiTitle: 'Already Derived' }],
  },
];

for (const skipCase of skipCases) {
  test(`does not write ${skipCase.label}`, async () => {
    await withIsolatedEnvironment(async ({ claudeHome }) => {
      const transcriptPath = await seedLegacySession({
        claudeHome,
        sessionId: 'skip-me',
        legacyName: skipCase.legacyName,
        transcriptLines: skipCase.transcriptLines,
      });
      const before = await readFile(transcriptPath as string, 'utf8');

      await flushLegacySessionNamesToTranscripts(getConnection());

      assert.equal(await readFile(transcriptPath as string, 'utf8'), before);
    });
  });
}

test('skips a session with no transcript without throwing', async () => {
  await withIsolatedEnvironment(async ({ claudeHome }) => {
    await seedLegacySession({
      claudeHome,
      sessionId: 'no-transcript',
      legacyName: 'a name with nowhere to go',
      withTranscript: false,
    });

    await flushLegacySessionNamesToTranscripts(getConnection());

    const row = getConnection()
      .prepare("SELECT provider_name FROM session_transcripts WHERE session_id = 'no-transcript'")
      .get() as { provider_name: string | null };
    assert.equal(row.provider_name, null);
  });
});

// ---------------------------------------------------------------------------
// One-shot behavior
// ---------------------------------------------------------------------------
test('runs once: drops its table and appends nothing on a second call', async () => {
  await withIsolatedEnvironment(async ({ claudeHome }) => {
    const transcriptPath = await seedLegacySession({
      claudeHome,
      sessionId: 'run-once',
      legacyName: 'promoted once',
      transcriptLines: [{ type: 'user', text: 'hi' }],
    });

    await flushLegacySessionNamesToTranscripts(getConnection());
    assert.equal(legacyTableExists(), false, 'the hand-off table must be dropped');
    const afterFirst = await readFile(transcriptPath as string, 'utf8');

    // A restart must not append a duplicate custom-title line.
    await flushLegacySessionNamesToTranscripts(getConnection());
    assert.equal(await readFile(transcriptPath as string, 'utf8'), afterFirst);

    const titleLines = afterFirst
      .trim()
      .split('\n')
      .filter((line) => JSON.parse(line).type === 'custom-title');
    assert.equal(titleLines.length, 1);
  });
});

// ---------------------------------------------------------------------------
// The property the feature exists for
// ---------------------------------------------------------------------------
test('a promoted name survives a later synchronizer pass', async () => {
  await withIsolatedEnvironment(async ({ claudeHome }) => {
    // The transcript needs sessionId/cwd on its first line for the synchronizer
    // to parse it, plus an ai-title that would otherwise win.
    const sessionId = 'survives-sync';
    const transcriptPath = await seedLegacySession({
      claudeHome,
      sessionId,
      legacyName: 'chosen by the user',
      transcriptLines: [
        { sessionId, cwd: '/tmp/demo', type: 'user', timestamp: '2026-01-01T10:00:00.000Z' },
        { type: 'ai-title', aiTitle: 'Generated Title', sessionId },
      ],
    });

    await flushLegacySessionNamesToTranscripts(getConnection());

    const { sessionSynchronizerService } = await import('@/modules/providers/index.js');
    getConnection().exec('DELETE FROM scan_state');
    await sessionSynchronizerService.synchronizeSessions();

    assert.equal(await readSessionTitle(transcriptPath as string), 'chosen by the user');
    const row = getConnection()
      .prepare('SELECT custom_name FROM session_rows WHERE session_id = ?')
      .get(sessionId) as { custom_name: string | null } | undefined;
    assert.equal(row?.custom_name, 'chosen by the user');
  });
});
