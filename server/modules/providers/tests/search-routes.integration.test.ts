import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import providerRoutes from '@/modules/providers/provider.routes.js';
import { indexFileIncrementally } from '@/modules/providers/services/session-index.service.js';

/**
 * Route-level contract for /search/sessions and /search/archived-sessions:
 * the legacy `q=` and structured `sq=` inputs must stay interchangeable for
 * plain text, since the sidebar sends `sq` while other callers still send `q`.
 */
async function withSearchServer(run: (baseUrl: string, dir: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'search-routes-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();

  const app = express();
  app.use('/api/providers', providerRoutes);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${port}/api/providers`, dir);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function seed(dir: string, sessionId: string, projectPath: string, texts: string[]): Promise<string> {
  const file = path.join(dir, `${sessionId}.jsonl`);
  await writeFile(
    file,
    texts
      .map((text, i) => `${JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: text },
        timestamp: '2026-10-15T12:00:00Z',
        uuid: `${sessionId}-${i}`,
      })}\n`)
      .join(''),
  );
  await indexFileIncrementally(file, projectPath);
  return sessionsDb.createSession(sessionId, 'claude', projectPath, undefined, '2026-10-15T00:00:00Z', '2026-10-15T00:00:01Z', file);
}

type SseEvent = { event: string; data: unknown };

async function readSse(url: string): Promise<SseEvent[]> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const body = await response.text();
  return body
    .split('\n\n')
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const lines = chunk.split('\n');
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? '';
      const data = lines.find((l) => l.startsWith('data: '))?.slice(6) ?? 'null';
      return { event, data: JSON.parse(data) };
    });
}

const sq = (value: unknown) => encodeURIComponent(JSON.stringify(value));

test('q=X and sq={"text":"X"} produce identical SSE streams (incl. paging)', async () => {
  await withSearchServer(async (base, dir) => {
    for (let i = 0; i < 6; i += 1) {
      await seed(dir, `s-${i}`, `/proj/${i % 2}`, [`zqroute alpha ${i}`, `zqroute beta ${i}`]);
    }

    const legacy = await readSse(`${base}/search/sessions?q=zqroute&limit=3`);
    const structured = await readSse(`${base}/search/sessions?sq=${sq({ text: 'zqroute' })}&limit=3`);
    assert.deepEqual(structured, legacy);
    assert.ok(legacy.some((e) => e.event === 'result'));

    const done = legacy.at(-1);
    assert.equal(done?.event, 'done');
    const cursor = (done?.data as { nextCursor: string | null }).nextCursor;
    assert.equal(typeof cursor, 'string');

    const legacyPage2 = await readSse(`${base}/search/sessions?q=zqroute&limit=3&cursor=${cursor}`);
    const structuredPage2 = await readSse(`${base}/search/sessions?sq=${sq({ text: 'zqroute' })}&limit=3&cursor=${cursor}`);
    assert.deepEqual(structuredPage2, legacyPage2);
  });
});

test('archived-sessions: q and sq return the same ids', async () => {
  await withSearchServer(async (base, dir) => {
    const archived = await seed(dir, 'arch', '/proj/a', ['zqarchroute body']);
    await seed(dir, 'active', '/proj/a', ['zqarchroute body']);
    sessionsDb.updateSessionIsArchived(archived, true);

    const legacy = (await (await fetch(`${base}/search/archived-sessions?q=zqarchroute`)).json()) as { data: { sessionIds: string[] } };
    const structured = await (await fetch(`${base}/search/archived-sessions?sq=${sq({ text: 'zqarchroute' })}`)).json();
    assert.deepEqual(structured, legacy);
    assert.deepEqual(legacy.data.sessionIds, [archived]);
  });
});

test('bad input is a 400 before streaming starts', async () => {
  await withSearchServer(async (base) => {
    assert.equal((await fetch(`${base}/search/sessions?sq=notjson`)).status, 400);
    assert.equal((await fetch(`${base}/search/sessions?sq=${sq({ text: 'ab' })}`)).status, 400);
    assert.equal((await fetch(`${base}/search/sessions?q=ab`)).status, 400);
  });
});
