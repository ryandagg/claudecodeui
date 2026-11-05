import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { extractFirstValidJsonlData, readFileLines } from '@/shared/utils.js';

// Regression coverage for a file-descriptor leak: `readline.Interface#close()`
// (all `for await` calls on early exit) does not destroy its input stream, so
// readers that stopped before EOF leaked one fd per call until
// `child_process.spawn` failed with EBADF.
//
// Fixtures must be larger than a ReadStream's 64 KiB highWaterMark: a smaller
// file is consumed in one chunk, hits EOF, and auto-closes — masking the leak.

const ITERATIONS = 25;

/** Open fds in this process; `/dev/fd` exists on both macOS and Linux. */
const openFdCount = () => fs.readdirSync('/dev/fd').length;

/** Lets pending async `fs.close` calls from destroyed streams settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function writeLargeJsonl(lines: unknown[]): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cg-read-lines-'));
  const filePath = path.join(dir, 'big.jsonl');
  const padding = Array.from({ length: 4000 }, (_, i) => ({ pad: i, filler: 'x'.repeat(40) }));
  const body = [...lines, ...padding].map((line) => JSON.stringify(line)).join('\n') + '\n';
  await fsp.writeFile(filePath, body, 'utf8');
  assert.ok(body.length > 128 * 1024, 'fixture must exceed the stream highWaterMark');
  return filePath;
}

async function assertNoFdGrowth(run: () => Promise<unknown>): Promise<void> {
  await run(); // warm up any lazily-opened handles before measuring
  await settle();
  const before = openFdCount();

  for (let i = 0; i < ITERATIONS; i += 1) {
    await run();
  }
  await settle();

  const growth = openFdCount() - before;
  // A leak grows by exactly ITERATIONS; allow small slack for unrelated runtime handles.
  assert.ok(growth < 5, `expected no fd leak, but open fds grew by ${growth} over ${ITERATIONS} reads`);
}

test('readFileLines yields every line of a file', async () => {
  const filePath = await writeLargeJsonl([{ first: true }]);
  try {
    let count = 0;
    let first: string | undefined;
    for await (const line of readFileLines(filePath)) {
      first ??= line;
      count += 1;
    }
    assert.equal(first, JSON.stringify({ first: true }));
    assert.equal(count, 4001);
  } finally {
    await fsp.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('readFileLines surfaces open errors to the caller', async () => {
  const missing = path.join(os.tmpdir(), 'cg-read-lines-does-not-exist.jsonl');
  await assert.rejects(async () => {
    for await (const _line of readFileLines(missing)) {
      // unreachable
    }
  }, { code: 'ENOENT' });
});

test('readFileLines releases the fd when the caller breaks early', async () => {
  const filePath = await writeLargeJsonl([{ first: true }]);
  try {
    await assertNoFdGrowth(async () => {
      for await (const _line of readFileLines(filePath)) {
        break;
      }
    });
  } finally {
    await fsp.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('readFileLines releases the fd when the caller throws mid-iteration', async () => {
  const filePath = await writeLargeJsonl([{ first: true }]);
  try {
    await assertNoFdGrowth(async () => {
      try {
        for await (const _line of readFileLines(filePath)) {
          throw new Error('boom');
        }
      } catch {
        // expected
      }
    });
  } finally {
    await fsp.rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('extractFirstValidJsonlData releases the fd on early match and on malformed lines', async () => {
  const matchFile = await writeLargeJsonl([{ sessionId: 'abc' }]);
  const malformedDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cg-read-lines-bad-'));
  const malformedFile = path.join(malformedDir, 'bad.jsonl');
  // A partially written first line makes JSON.parse throw out of the loop.
  await fsp.writeFile(malformedFile, '{"truncated": \n' + 'y'.repeat(200 * 1024) + '\n', 'utf8');

  try {
    await assertNoFdGrowth(async () => {
      const found = await extractFirstValidJsonlData(matchFile, (row) =>
        (row as { sessionId?: string }).sessionId ?? null,
      );
      assert.equal(found, 'abc');
    });

    await assertNoFdGrowth(async () => {
      assert.equal(await extractFirstValidJsonlData(malformedFile, () => 'never'), null);
    });
  } finally {
    await fsp.rm(path.dirname(matchFile), { recursive: true, force: true });
    await fsp.rm(malformedDir, { recursive: true, force: true });
  }
});
