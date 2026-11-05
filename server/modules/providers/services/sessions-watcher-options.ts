import path from 'node:path';
import type { Stats } from 'node:fs';

import type { ChokidarOptions } from 'chokidar';

/**
 * Subdirectory levels below a provider root the watcher descends.
 *
 * Claude lays transcripts out as `projects/<encoded-cwd>/<session-id>.jsonl`,
 * i.e. one level down. Deeper files (`<session-id>/subagents/*.jsonl`,
 * `<session-id>/tool-results/*`) are skipped by both the synchronizer and the
 * search indexer, so watching them would only add directory handles and noise.
 * Depth 1 still sees brand-new project directories and the files created in
 * them (verified against chokidar 4).
 */
export const WATCHER_DEPTH = 1;

/** Poll cadence used only when polling is explicitly opted into. */
export const WATCHER_POLL_INTERVAL_MS = 6_000;

const IGNORED_DIR_SEGMENTS = new Set(['node_modules', '.git', 'dist', 'build']);

/**
 * chokidar 4 dropped glob support, so `ignored` must be a predicate. Ignores
 * well-known junk directories and every regular file that is not a `.jsonl`
 * transcript, so editor temp files, `.DS_Store`, etc. never emit events.
 */
export function isIgnoredWatchPath(filePath: string, stats?: Stats): boolean {
  if (path.normalize(filePath).split(path.sep).some((segment) => IGNORED_DIR_SEGMENTS.has(segment))) {
    return true;
  }
  return Boolean(stats?.isFile()) && !filePath.endsWith('.jsonl');
}

/**
 * Stat-polling is opt-in (network filesystems, some containers) because a
 * polling watcher stats the whole tree every interval; native events
 * (FSEvents on macOS, inotify on Linux) cost nothing while idle.
 */
export function isWatcherPollingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CLOUDCLI_WATCH_POLLING?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function buildWatcherOptions(env: NodeJS.ProcessEnv = process.env): ChokidarOptions {
  const usePolling = isWatcherPollingEnabled(env);
  return {
    ignored: isIgnoredWatchPath,
    persistent: true,
    ignoreInitial: true,
    followSymlinks: false,
    depth: WATCHER_DEPTH,
    usePolling,
    ...(usePolling ? { interval: WATCHER_POLL_INTERVAL_MS, binaryInterval: WATCHER_POLL_INTERVAL_MS } : {}),
  };
}

type KeyedCoalescerOptions<E> = {
  /** Quiet period after the last event before the key is processed. */
  debounceMs: number;
  /** Upper bound from the first pending event, so a continuously-growing file still gets processed. */
  maxWaitMs: number;
  /** Folds a new event into the pending one for the same key. */
  merge: (previous: E, next: E) => E;
  run: (key: string, event: E) => Promise<void>;
};

export type KeyedCoalescer<E> = {
  push: (key: string, event: E) => void;
  /** Cancels pending timers; in-flight runs finish but are not rescheduled. */
  close: () => void;
};

/**
 * Per-key trailing debounce with a max wait, plus per-key serialization.
 *
 * Native watchers fire on every write, and a streaming transcript is appended
 * many times per second. This restores the batching the 6s poll gave for free,
 * and guarantees a file is never synchronized/indexed by two overlapping runs
 * (an event arriving mid-run is processed once the run finishes).
 */
export function createKeyedCoalescer<E>(options: KeyedCoalescerOptions<E>): KeyedCoalescer<E> {
  type Entry = {
    event: E | null;
    firstPendingAt: number;
    timer: ReturnType<typeof setTimeout> | null;
    running: boolean;
  };
  const entries = new Map<string, Entry>();
  let closed = false;

  const arm = (key: string, entry: Entry): void => {
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    const remaining = Math.max(0, options.maxWaitMs - (Date.now() - entry.firstPendingAt));
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void fire(key, entry);
    }, Math.min(options.debounceMs, remaining));
  };

  const fire = async (key: string, entry: Entry): Promise<void> => {
    if (closed || entry.running || entry.event === null) {
      return;
    }
    const event = entry.event;
    entry.event = null;
    entry.running = true;
    try {
      await options.run(key, event);
    } catch {
      // `run` owns its error reporting; never let one key wedge the coalescer.
    } finally {
      entry.running = false;
      if (closed) {
        entries.delete(key);
      } else if (entry.event !== null) {
        arm(key, entry);
      } else if (!entry.timer) {
        entries.delete(key);
      }
    }
  };

  return {
    push(key, event) {
      if (closed) {
        return;
      }
      let entry = entries.get(key);
      if (!entry) {
        entry = { event: null, firstPendingAt: Date.now(), timer: null, running: false };
        entries.set(key, entry);
      }
      if (entry.event === null) {
        entry.event = event;
        entry.firstPendingAt = Date.now();
      } else {
        entry.event = options.merge(entry.event, event);
      }
      if (!entry.running) {
        arm(key, entry);
      }
    },
    close() {
      closed = true;
      for (const entry of entries.values()) {
        if (entry.timer) {
          clearTimeout(entry.timer);
        }
      }
      entries.clear();
    },
  };
}
