import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import chokidar from 'chokidar';

import {
  WATCHER_DEPTH,
  WATCHER_POLL_INTERVAL_MS,
  buildWatcherOptions,
  createKeyedCoalescer,
  isIgnoredWatchPath,
  isWatcherPollingEnabled,
} from '@/modules/providers/services/sessions-watcher-options.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fileStats = { isFile: () => true } as Stats;
const dirStats = { isFile: () => false } as Stats;

// ---------------------------------------------------------------------------
// buildWatcherOptions / polling opt-in
// ---------------------------------------------------------------------------
test('buildWatcherOptions defaults to native events with shallow depth', () => {
  const options = buildWatcherOptions({});
  assert.equal(options.usePolling, false);
  assert.equal(options.depth, WATCHER_DEPTH);
  assert.equal(options.depth, 1);
  assert.equal(options.ignoreInitial, true);
  assert.equal(options.followSymlinks, false);
  assert.equal('interval' in options, false);
  assert.equal(typeof options.ignored, 'function');
});

test('CLOUDCLI_WATCH_POLLING opts into stat-polling with the 6s interval', () => {
  const options = buildWatcherOptions({ CLOUDCLI_WATCH_POLLING: '1' });
  assert.equal(options.usePolling, true);
  assert.equal(options.interval, WATCHER_POLL_INTERVAL_MS);
  assert.equal(options.binaryInterval, WATCHER_POLL_INTERVAL_MS);
});

test('isWatcherPollingEnabled accepts truthy spellings only', () => {
  for (const value of ['1', 'true', 'TRUE', ' yes ']) {
    assert.equal(isWatcherPollingEnabled({ CLOUDCLI_WATCH_POLLING: value }), true, value);
  }
  for (const value of [undefined, '', '0', 'false', 'no']) {
    assert.equal(isWatcherPollingEnabled({ CLOUDCLI_WATCH_POLLING: value }), false, String(value));
  }
});

// ---------------------------------------------------------------------------
// isIgnoredWatchPath
// ---------------------------------------------------------------------------
test('isIgnoredWatchPath keeps directories and .jsonl files, drops other files and junk dirs', () => {
  assert.equal(isIgnoredWatchPath('/h/.claude/projects/-proj', dirStats), false);
  assert.equal(isIgnoredWatchPath('/h/.claude/projects/-proj/abc.jsonl', fileStats), false);
  // chokidar first calls the matcher without stats; must not reject then.
  assert.equal(isIgnoredWatchPath('/h/.claude/projects/-proj/abc.jsonl'), false);
  assert.equal(isIgnoredWatchPath('/h/.claude/projects/-proj'), false);

  assert.equal(isIgnoredWatchPath('/h/.claude/projects/-proj/.DS_Store', fileStats), true);
  assert.equal(isIgnoredWatchPath('/h/.claude/projects/-proj/abc.jsonl.tmp', fileStats), true);
  assert.equal(isIgnoredWatchPath('/h/.claude/projects/-proj/node_modules', dirStats), true);
  assert.equal(isIgnoredWatchPath('/h/.claude/projects/-proj/.git/x.jsonl', fileStats), true);
});

// ---------------------------------------------------------------------------
// Real chokidar against a Claude-shaped tree: depth 1 must see new project
// dirs, new sessions in them, and appends; it need not see subagent files.
// ---------------------------------------------------------------------------
test('watcher options see new sessions and appends at projects/<proj>/<id>.jsonl', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cloudcli-watch-'));
  mkdirSync(path.join(root, 'existing', 'sess', 'subagents'), { recursive: true });
  writeFileSync(path.join(root, 'existing', 'old.jsonl'), '{}\n');

  const watcher = chokidar.watch(root, buildWatcherOptions({}));
  const seen: string[] = [];
  watcher.on('add', (p: string) => seen.push(`add ${path.relative(root, p)}`));
  watcher.on('change', (p: string) => seen.push(`change ${path.relative(root, p)}`));
  try {
    await new Promise<void>((resolve) => watcher.on('ready', () => resolve()));

    appendFileSync(path.join(root, 'existing', 'old.jsonl'), '{}\n');
    writeFileSync(path.join(root, 'existing', 'notes.txt'), 'x');
    mkdirSync(path.join(root, 'brand-new'));
    await sleep(300);
    writeFileSync(path.join(root, 'brand-new', 'new.jsonl'), '{}\n');

    const expected = ['change existing/old.jsonl', 'add brand-new/new.jsonl'];
    for (let i = 0; i < 40 && !expected.every((e) => seen.includes(e)); i += 1) {
      await sleep(100);
    }
    for (const e of expected) {
      assert.ok(seen.includes(e), `expected "${e}" in ${JSON.stringify(seen)}`);
    }
    assert.ok(!seen.some((e) => e.endsWith('notes.txt')), `non-jsonl leaked: ${JSON.stringify(seen)}`);
  } finally {
    await watcher.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// createKeyedCoalescer
// ---------------------------------------------------------------------------
test('coalescer collapses a burst for one key into a single run with merged event', async () => {
  const runs: Array<[string, string]> = [];
  const c = createKeyedCoalescer<string>({
    debounceMs: 30,
    maxWaitMs: 1_000,
    merge: (prev, next) => (prev === 'add' ? prev : next),
    run: async (key, event) => {
      runs.push([key, event]);
    },
  });
  c.push('a', 'add');
  c.push('a', 'change');
  c.push('b', 'change');
  c.push('a', 'change');
  await sleep(80);
  assert.deepEqual(runs.sort(), [['a', 'add'], ['b', 'change']]);
  c.close();
});

test('coalescer max wait fires even while events keep arriving', async () => {
  let runs = 0;
  const c = createKeyedCoalescer<number>({
    debounceMs: 40,
    maxWaitMs: 100,
    merge: (_prev, next) => next,
    run: async () => {
      runs += 1;
    },
  });
  const started = Date.now();
  while (Date.now() - started < 180) {
    c.push('k', 1);
    await sleep(10);
  }
  assert.ok(runs >= 1, `expected a max-wait run during a continuous stream, got ${runs}`);
  c.close();
});

test('coalescer never overlaps runs for one key and re-runs for events during a run', async () => {
  let active = 0;
  let maxActive = 0;
  const events: number[] = [];
  let release: () => void = () => {};
  const c = createKeyedCoalescer<number>({
    debounceMs: 10,
    maxWaitMs: 100,
    merge: (_prev, next) => next,
    run: async (_key, event) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(event);
      if (event === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      active -= 1;
    },
  });
  c.push('k', 1);
  await sleep(30); // first run now in flight and blocked
  c.push('k', 2);
  c.push('k', 3);
  await sleep(50);
  assert.deepEqual(events, [1], 'must not start a second run while the first is in flight');
  release();
  await sleep(50);
  assert.deepEqual(events, [1, 3]);
  assert.equal(maxActive, 1);
  c.close();
});

test('coalescer survives a throwing run and drops pending work on close', async () => {
  const runs: number[] = [];
  const c = createKeyedCoalescer<number>({
    debounceMs: 10,
    maxWaitMs: 100,
    merge: (_prev, next) => next,
    run: async (_key, event) => {
      runs.push(event);
      if (event === 1) {
        throw new Error('boom');
      }
    },
  });
  c.push('k', 1);
  await sleep(30);
  c.push('k', 2);
  await sleep(30);
  assert.deepEqual(runs, [1, 2]);

  c.push('k', 3);
  c.close();
  await sleep(30);
  assert.deepEqual(runs, [1, 2]);
});
