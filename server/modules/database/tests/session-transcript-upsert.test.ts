import assert from 'node:assert/strict';
import test from 'node:test';

import { getConnection } from '@/modules/database/connection.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { withIsolatedDatabase, seedUser } from '@/modules/database/tests/helpers.js';

function readTranscript(sessionId: string) {
  return getConnection()
    .prepare(
      `SELECT provider_name, jsonl_path, first_message_at, last_message_at, indexed_at
       FROM session_transcripts WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        provider_name: string | null;
        jsonl_path: string | null;
        first_message_at: string | null;
        last_message_at: string | null;
        indexed_at: string;
      }
    | undefined;
}

test('provider_name is authoritative: a null title clears a stale cached name', async () => {
  await withIsolatedDatabase('transcript-upsert', () => {
    seedUser();
    sessionsDb.createSession('s1', 'claude', '/ws/demo', 'Real AI Title', undefined, undefined, '/ws/demo/s1.jsonl');
    assert.equal(readTranscript('s1')?.provider_name, 'Real AI Title');

    // A later scan finds no title line in the transcript → clears the name,
    // but must not blank the path or timestamps (those stay additive).
    sessionsDb.upsertSessionTranscript('s1', { providerName: null });

    const row = readTranscript('s1');
    assert.equal(row?.provider_name, null);
    assert.equal(row?.jsonl_path, '/ws/demo/s1.jsonl', 'path is preserved on a null-name upsert');
  });
});

test('clears a fabricated placeholder name left by an earlier build', async () => {
  await withIsolatedDatabase('transcript-upsert', () => {
    seedUser();
    sessionsDb.createSession('s1', 'claude', '/ws/demo', 'Untitled Claude Session', undefined, undefined, '/ws/demo/s1.jsonl');
    assert.equal(readTranscript('s1')?.provider_name, 'Untitled Claude Session');

    sessionsDb.upsertSessionTranscript('s1', { providerName: null, jsonlPath: '/ws/demo/s1.jsonl' });

    assert.equal(readTranscript('s1')?.provider_name, null);
  });
});

test('an unchanged upsert is a no-op: indexed_at does not advance', async () => {
  await withIsolatedDatabase('transcript-upsert', () => {
    seedUser();
    sessionsDb.createSession('s1', 'claude', '/ws/demo', 'Stable Title', '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z', '/ws/demo/s1.jsonl');
    const before = readTranscript('s1');

    // Force a distinct wall-clock so a real write would change indexed_at.
    getConnection()
      .prepare(`UPDATE session_transcripts SET indexed_at = '2000-01-01 00:00:00' WHERE session_id = ?`)
      .run('s1');
    const stamped = readTranscript('s1')?.indexed_at;

    // Re-emit the identical facts, as an idempotent ai-title re-write would.
    sessionsDb.upsertSessionTranscript('s1', {
      providerName: 'Stable Title',
      jsonlPath: '/ws/demo/s1.jsonl',
      firstMessageAt: before?.first_message_at ?? undefined,
      lastMessageAt: before?.last_message_at ?? undefined,
    });

    assert.equal(readTranscript('s1')?.indexed_at, stamped, 'no-op upsert must not touch the row');
  });
});

test('a changed field does write, advancing the row', async () => {
  await withIsolatedDatabase('transcript-upsert', () => {
    seedUser();
    sessionsDb.createSession('s1', 'claude', '/ws/demo', 'Old Title', undefined, undefined, '/ws/demo/s1.jsonl');
    getConnection()
      .prepare(`UPDATE session_transcripts SET indexed_at = '2000-01-01 00:00:00' WHERE session_id = ?`)
      .run('s1');

    sessionsDb.upsertSessionTranscript('s1', { providerName: 'New Title', jsonlPath: '/ws/demo/s1.jsonl' });

    const row = readTranscript('s1');
    assert.equal(row?.provider_name, 'New Title');
    assert.notEqual(row?.indexed_at, '2000-01-01 00:00:00', 'a real change must advance indexed_at');
  });
});
