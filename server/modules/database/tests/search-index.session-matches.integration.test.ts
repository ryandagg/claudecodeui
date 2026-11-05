import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import {
  searchIndexDb,
  toFtsMatchLiteral,
  type IndexableMessage,
  type SessionMatchSearchParams,
} from '@/modules/database/repositories/search-index.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'search-session-matches-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function msg(seq: number, text: string, opts: { role?: string; timestamp?: string | null } = {}): IndexableMessage {
  return {
    role: opts.role ?? 'assistant',
    text,
    timestamp: opts.timestamp === undefined ? '2026-10-15T12:00:00Z' : opts.timestamp,
    messageUuid: `u-${seq}`,
    seq,
  };
}

function seed(jsonlPath: string, projectPath: string | null, messages: IndexableMessage[]): void {
  searchIndexDb.replaceFileMessages(jsonlPath, projectPath, messages, 1, 1);
}

const base = (overrides: Partial<SessionMatchSearchParams> = {}): SessionMatchSearchParams => ({
  matchLiteral: toFtsMatchLiteral('needle'),
  perSessionLimit: 2,
  limit: 100,
  ...overrides,
});

test('caps rows per session and keeps each session contiguous', async () => {
  await withIsolatedDatabase(() => {
    seed('/a.jsonl', '/p', [msg(0, 'needle one'), msg(1, 'needle two'), msg(2, 'needle three')]);
    seed('/b.jsonl', '/p', [msg(0, 'needle x'), msg(1, 'needle y')]);

    const rows = searchIndexDb.searchSessionMatches(base());
    assert.equal(rows.length, 4);
    const sessions = rows.map((r) => r.jsonl_path);
    // Contiguous: never a/b/a.
    assert.deepEqual(sessions, [...sessions].sort((x, y) => sessions.indexOf(x) - sessions.indexOf(y)));
    assert.equal(rows.filter((r) => r.jsonl_path === '/a.jsonl').length, 2);
    assert.deepEqual(rows.filter((r) => r.jsonl_path === '/a.jsonl').map((r) => r.session_rank), [1, 2]);
  });
});

test('allowed jsonlPaths filter does not starve results when most hits are excluded', async () => {
  await withIsolatedDatabase(() => {
    // 300 excluded sessions, each with many strong hits, outrank the 3 allowed ones.
    for (let i = 0; i < 300; i += 1) {
      seed(`/noise-${i}.jsonl`, '/noise', [
        msg(0, 'needle needle needle'),
        msg(1, 'needle needle needle'),
        msg(2, 'needle needle needle'),
      ]);
    }
    const allowed = ['/keep-1.jsonl', '/keep-2.jsonl', '/keep-3.jsonl'];
    for (const p of allowed) {
      seed(p, '/keep', [msg(0, `a long body that mentions the needle only once among many other words ${p}`)]);
    }

    const rows = searchIndexDb.searchSessionMatches(base({ jsonlPaths: allowed, limit: 3 }));
    assert.deepEqual(rows.map((r) => r.jsonl_path).sort(), allowed);
  });
});

test('empty allowed set returns nothing', async () => {
  await withIsolatedDatabase(() => {
    seed('/a.jsonl', '/p', [msg(0, 'needle')]);
    assert.deepEqual(searchIndexDb.searchSessionMatches(base({ jsonlPaths: [] })), []);
  });
});

test('project include / exclude (exclude wins on overlap)', async () => {
  await withIsolatedDatabase(() => {
    seed('/a.jsonl', '/proj/a', [msg(0, 'needle')]);
    seed('/b.jsonl', '/proj/b', [msg(0, 'needle')]);
    seed('/c.jsonl', null, [msg(0, 'needle')]);

    const paths = (p: SessionMatchSearchParams['projectPaths']) =>
      searchIndexDb.searchSessionMatches(base({ projectPaths: p })).map((r) => r.jsonl_path).sort();

    assert.deepEqual(paths({ include: ['/proj/a'] }), ['/a.jsonl']);
    assert.deepEqual(paths({ exclude: ['/proj/a'] }), ['/b.jsonl', '/c.jsonl']);
    assert.deepEqual(paths({ include: ['/proj/a', '/proj/b'], exclude: ['/proj/a'] }), ['/b.jsonl']);
    assert.deepEqual(paths({ include: [] }), []);
    assert.deepEqual(paths({ exclude: [] }), ['/a.jsonl', '/b.jsonl', '/c.jsonl']);
  });
});

test('role filter', async () => {
  await withIsolatedDatabase(() => {
    seed('/a.jsonl', '/p', [msg(0, 'needle from user', { role: 'user' }), msg(1, 'needle from assistant')]);
    const rows = searchIndexDb.searchSessionMatches(base({ roles: ['user'] }));
    assert.deepEqual(rows.map((r) => r.role), ['user']);
    assert.equal(searchIndexDb.searchSessionMatches(base({ roles: [] })).length, 2);
  });
});

test('date filter: after inclusive, before exclusive, null timestamps dropped', async () => {
  await withIsolatedDatabase(() => {
    seed('/a.jsonl', '/p', [
      msg(0, 'needle early', { timestamp: '2026-09-30T23:59:59.999Z' }),
      msg(1, 'needle boundary', { timestamp: '2026-10-01T00:00:00Z' }),
      msg(2, 'needle late', { timestamp: '2026-10-20T08:00:00.123Z' }),
      msg(3, 'needle undated', { timestamp: null }),
    ]);
    const seqs = (after: string | null, before: string | null) =>
      searchIndexDb
        .searchSessionMatches(base({ after, before, perSessionLimit: 10 }))
        .map((r) => r.seq)
        .sort();

    assert.deepEqual(seqs('2026-10-01T00:00:00.000Z', null), [1, 2]);
    assert.deepEqual(seqs(null, '2026-10-01T00:00:00.000Z'), [0]);
    assert.deepEqual(seqs('2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z'), [1]);
    assert.deepEqual(seqs(null, null), [0, 1, 2, 3]);
  });
});

test('LIMIT/OFFSET pages through the session-ordered rows without gaps or duplicates', async () => {
  await withIsolatedDatabase(() => {
    for (let i = 0; i < 7; i += 1) {
      seed(`/s-${i}.jsonl`, '/p', [msg(0, `needle ${i}`), msg(1, `needle again ${i}`)]);
    }
    const all = searchIndexDb.searchSessionMatches(base({ limit: 1000 }));
    assert.equal(all.length, 14);
    const paged = [
      ...searchIndexDb.searchSessionMatches(base({ limit: 5, offset: 0 })),
      ...searchIndexDb.searchSessionMatches(base({ limit: 5, offset: 5 })),
      ...searchIndexDb.searchSessionMatches(base({ limit: 5, offset: 10 })),
    ];
    assert.deepEqual(
      paged.map((r) => `${r.jsonl_path}#${r.seq}`),
      all.map((r) => `${r.jsonl_path}#${r.seq}`),
    );
  });
});
