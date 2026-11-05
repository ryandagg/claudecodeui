import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import chokidar from 'chokidar';

import {
  WATCHER_DEPTH,
  WATCHER_POLL_INTERVAL_MS,
  attachNativeTranscriptEvents,
  buildWatcherOptions,
  createKeyedCoalescer,
  isIgnoredNativeWatchPath,
  isIgnoredPollingWatchPath,
  isWatcherPollingEnabled,
  resolveRawTranscriptPath,
} from '@/modules/providers/services/sessions-watcher-options.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fileStats = { isFile: () => true } as Stats;
const dirStats = { isFile: () => false } as Stats;

// ---------------------------------------------------------------------------
// buildWatcherOptions / polling opt-in
// ---------------------------------------------------------------------------
test('buildWatcherOptions defaults to native, directory-only watching at depth 1', () => {
  const options = buildWatcherOptions({});
  assert.equal(options.usePolling, false);
  assert.equal(options.depth, WATCHER_DEPTH);
  assert.equal(options.depth, 1);
  assert.equal(options.ignoreInitial, true);
  assert.equal(options.followSymlinks, false);
  assert.equal('interval' in options, false);
  assert.equal(options.ignored, isIgnoredNativeWatchPath);
});

test('CLOUDCLI_WATCH_POLLING opts into stat-polling with per-file watching and the 6s interval', () => {
  const options = buildWatcherOptions({ CLOUDCLI_WATCH_POLLING: '1' });
  assert.equal(options.usePolling, true);
  assert.equal(options.interval, WATCHER_POLL_INTERVAL_MS);
  assert.equal(options.binaryInterval, WATCHER_POLL_INTERVAL_MS);
  assert.equal(options.ignored, isIgnoredPollingWatchPath);
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
// ignore predicates
// ---------------------------------------------------------------------------
test('native predicate keeps directories only, so no per-file fd is ever opened', () => {
  assert.equal(isIgnoredNativeWatchPath('/h/.claude/projects/-proj', dirStats), false);
  // chokidar first calls the matcher without stats; must not reject then.
  assert.equal(isIgnoredNativeWatchPath('/h/.claude/projects/-proj'), false);
  assert.equal(isIgnoredNativeWatchPath('/h/.claude/projects/-proj/abc.jsonl', fileStats), true);
  assert.equal(isIgnoredNativeWatchPath('/h/.claude/projects/-proj/.DS_Store', fileStats), true);
  assert.equal(isIgnoredNativeWatchPath('/h/.claude/projects/-proj/node_modules', dirStats), true);
});

test('polling predicate keeps directories and .jsonl files, drops other files and junk dirs', () => {
  assert.equal(isIgnoredPollingWatchPath('/h/.claude/projects/-proj', dirStats), false);
  assert.equal(isIgnoredPollingWatchPath('/h/.claude/projects/-proj/abc.jsonl', fileStats), false);
  assert.equal(isIgnoredPollingWatchPath('/h/.claude/projects/-proj/abc.jsonl'), false);
  assert.equal(isIgnoredPollingWatchPath('/h/.claude/projects/-proj/.DS_Store', fileStats), true);
  assert.equal(isIgnoredPollingWatchPath('/h/.claude/projects/-proj/abc.jsonl.tmp', fileStats), true);
  assert.equal(isIgnoredPollingWatchPath('/h/.claude/projects/-proj/node_modules', dirStats), true);
  assert.equal(isIgnoredPollingWatchPath('/h/.claude/projects/-proj/.git/x.jsonl', fileStats), true);
});

// ---------------------------------------------------------------------------
// resolveRawTranscriptPath
// ---------------------------------------------------------------------------
test('resolveRawTranscriptPath joins .jsonl filenames onto the watched dir and rejects the rest', () => {
  assert.equal(resolveRawTranscriptPath('/p/-proj', 'abc.jsonl'), path.join('/p/-proj', 'abc.jsonl'));
  assert.equal(resolveRawTranscriptPath('/p/-proj', '/abs/abc.jsonl'), '/abs/abc.jsonl');
  assert.equal(resolveRawTranscriptPath('/p/-proj', 'notes.txt'), null);
  assert.equal(resolveRawTranscriptPath('/p/-proj', 'abc.jsonl.tmp'), null);
  assert.equal(resolveRawTranscriptPath('/p/-proj', null), null);
  assert.equal(resolveRawTranscriptPath(undefined, 'abc.jsonl'), null);
  assert.equal(resolveRawTranscriptPath('/p/node_modules', 'abc.jsonl'), null);
});

// ---------------------------------------------------------------------------
// Real chokidar + attachNativeTranscriptEvents against a Claude-shaped tree:
// only directories hold watch handles, yet appends to existing sessions and
// sessions created in new project dirs (even before the dir is watched) are
// reported, while non-transcript files are not.
// ---------------------------------------------------------------------------
test('native wiring watches no files yet reports session appends and new sessions', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cloudcli-watch-'));
  mkdirSync(path.join(root, 'existing', 'sess', 'subagents'), { recursive: true });
  writeFileSync(path.join(root, 'existing', 'old.jsonl'), '{}\n');

  const watcher = chokidar.watch(root, buildWatcherOptions({}));
  const seen = new Set<string>();
  attachNativeTranscriptEvents(watcher, (filePath) => {
    seen.add(path.relative(root, filePath));
  });
  try {
    await new Promise<void>((resolve) => watcher.on('ready', () => resolve()));
    // FSEvents drops events in the first moments of a new stream; the server
    // covers that window with its initial synchronization pass.
    await sleep(300);

    const watchedEntries = Object.entries(watcher.getWatched()).flatMap(([dir, names]) =>
      names.map((name) => path.join(dir, name)));
    assert.ok(
      !watchedEntries.some((entry) => entry.endsWith('.jsonl')),
      `no transcript file may hold a watch handle: ${JSON.stringify(watchedEntries)}`
    );

    appendFileSync(path.join(root, 'existing', 'old.jsonl'), '{}\n');
    writeFileSync(path.join(root, 'existing', 'notes.txt'), 'x');
    // Written immediately, before chokidar can attach to the new dir: only
    // the addDir listing can catch it.
    mkdirSync(path.join(root, 'brand-new'));
    writeFileSync(path.join(root, 'brand-new', 'new.jsonl'), '{}\n');

    const expected = [path.join('existing', 'old.jsonl'), path.join('brand-new', 'new.jsonl')];
    for (let i = 0; i < 50 && !expected.every((e) => seen.has(e)); i += 1) {
      await sleep(100);
    }
    for (const e of expected) {
      assert.ok(seen.has(e), `expected "${e}" in ${JSON.stringify([...seen])}`);
    }
    assert.ok(![...seen].some((e) => e.endsWith('notes.txt')), `non-jsonl leaked: ${JSON.stringify([...seen])}`);
  } finally {
    await watcher.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// createKeyedCoalescer — fake timers so CI load cannot flake the margins.
// ---------------------------------------------------------------------------
/** Lets resolved promises (run completions) settle; setImmediate is not mocked. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function withFakeTimers(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    try {
      await fn();
    } finally {
      mock.timers.reset();
    }
  };
}

test('coalescer collapses a burst for one key into a single run with merged event', withFakeTimers(async () => {
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
  mock.timers.tick(20);
  c.push('a', 'change'); // resets a's debounce
  mock.timers.tick(20);
  await flush();
  assert.deepEqual(runs, [['b', 'change']]);
  mock.timers.tick(20);
  await flush();
  assert.deepEqual(runs, [['b', 'change'], ['a', 'add']]);
  c.close();
}));

test('coalescer max wait fires even while events keep arriving', withFakeTimers(async () => {
  let runs = 0;
  const c = createKeyedCoalescer<number>({
    debounceMs: 40,
    maxWaitMs: 100,
    merge: (_prev, next) => next,
    run: async () => {
      runs += 1;
    },
  });
  for (let t = 0; t < 100; t += 10) {
    c.push('k', t);
    mock.timers.tick(10);
    await flush();
  }
  assert.equal(runs, 1, 'a continuous stream must still run once the max wait elapses');
  c.close();
}));

test('coalescer never overlaps runs for one key and re-runs for events during a run', withFakeTimers(async () => {
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
  mock.timers.tick(10);
  await flush(); // first run now in flight and blocked
  c.push('k', 2);
  c.push('k', 3);
  mock.timers.tick(1_000);
  await flush();
  assert.deepEqual(events, [1], 'must not start a second run while the first is in flight');
  release();
  await flush();
  mock.timers.tick(10);
  await flush();
  assert.deepEqual(events, [1, 3]);
  assert.equal(maxActive, 1);
  c.close();
}));

test('coalescer survives a throwing run', withFakeTimers(async () => {
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
  mock.timers.tick(10);
  await flush();
  c.push('k', 2);
  mock.timers.tick(10);
  await flush();
  assert.deepEqual(runs, [1, 2]);
  c.close();
}));

test('close() drops pending events, including ones queued behind an in-flight run', withFakeTimers(async () => {
  const runs: string[] = [];
  let release: () => void = () => {};
  const c = createKeyedCoalescer<string>({
    debounceMs: 10,
    maxWaitMs: 100,
    merge: (_prev, next) => next,
    run: async (key, event) => {
      runs.push(`${key}:${event}`);
      if (key === 'busy') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    },
  });
  c.push('busy', 'first');
  mock.timers.tick(10);
  await flush(); // busy:first in flight
  c.push('busy', 'queued'); // waits behind the in-flight run
  c.push('idle', 'pending'); // still debouncing
  c.close();
  release();
  await flush();
  mock.timers.tick(1_000);
  await flush();
  assert.deepEqual(runs, ['busy:first']);
  c.push('idle', 'after-close');
  mock.timers.tick(1_000);
  await flush();
  assert.deepEqual(runs, ['busy:first']);
}));
