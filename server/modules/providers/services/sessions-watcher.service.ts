import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import chokidar, { type FSWatcher } from 'chokidar';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { sessionIndexService } from '@/modules/providers/services/session-index.service.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import { getClaudeHome } from '@/shared/utils.js';
import type { LLMProvider } from '@/shared/types.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import {
  buildWatcherOptions,
  createKeyedCoalescer,
  type KeyedCoalescer,
} from '@/modules/providers/services/sessions-watcher-options.js';

type WatcherEventType = 'add' | 'change';

/**
 * Resolved per call rather than at module load so the watch root cannot drift
 * from the synchronizer's, which reads the same setting. The two disagreeing
 * would mean watching one tree and indexing another.
 */
const getProviderWatchPaths = (): Array<{ provider: LLMProvider; rootPath: string }> => [
  {
    provider: 'claude',
    rootPath: path.join(getClaudeHome(), 'projects'),
  },
];

const PROJECTS_UPDATE_DEBOUNCE_MS = 500;
const PROJECTS_UPDATE_MAX_WAIT_MS = 2_000;

/**
 * Per-file coalescing of raw watcher events before sync + incremental index.
 * Native events fire on every append; this keeps a streaming transcript from
 * being re-synced dozens of times a second while still landing within ~2s.
 */
const FILE_EVENT_DEBOUNCE_MS = 400;
const FILE_EVENT_MAX_WAIT_MS = 2_000;

const watchers: FSWatcher[] = [];

type FileEvent = { eventType: WatcherEventType; provider: LLMProvider };

let fileEventCoalescer: KeyedCoalescer<FileEvent> | null = null;

function getFileEventCoalescer(): KeyedCoalescer<FileEvent> {
  if (!fileEventCoalescer) {
    fileEventCoalescer = createKeyedCoalescer<FileEvent>({
      debounceMs: FILE_EVENT_DEBOUNCE_MS,
      maxWaitMs: FILE_EVENT_MAX_WAIT_MS,
      // An `add` folded with later `change`s is still a new file to the client.
      merge: (previous, next) => (previous.eventType === 'add' ? previous : next),
      run: (filePath, { eventType, provider }) => onUpdate(eventType, filePath, provider),
    });
  }
  return fileEventCoalescer;
}

type PendingWatcherUpdate = {
  providers: Set<LLMProvider>;
  changeTypes: Set<WatcherEventType>;
  /**
   * Provider-native session ids reported by the synchronizers. They are
   * translated back to app-facing session rows at flush time, because the
   * transcript file names on disk only ever contain provider ids.
   */
  updatedSessionIds: Set<string>;
};

let pendingWatcherUpdate: PendingWatcherUpdate | null = null;
let pendingWatcherUpdateStartedAt: number | null = null;
let pendingWatcherFlushTimer: ReturnType<typeof setTimeout> | null = null;
let watcherRefreshInFlight = false;
let watcherRescheduleAfterRefresh = false;

/**
 * Filters watcher events to provider-specific session artifact file types.
 */
function isWatcherTargetFile(_provider: LLMProvider, filePath: string): boolean {
  return filePath.endsWith('.jsonl');
}

function clearPendingWatcherFlushTimer(): void {
  if (pendingWatcherFlushTimer) {
    clearTimeout(pendingWatcherFlushTimer);
    pendingWatcherFlushTimer = null;
  }
}

function schedulePendingWatcherFlush(): void {
  if (!pendingWatcherUpdate) {
    return;
  }

  const now = Date.now();
  if (pendingWatcherUpdateStartedAt === null) {
    pendingWatcherUpdateStartedAt = now;
  }

  const elapsed = now - pendingWatcherUpdateStartedAt;
  const remainingMaxWait = Math.max(0, PROJECTS_UPDATE_MAX_WAIT_MS - elapsed);
  const delay = Math.min(PROJECTS_UPDATE_DEBOUNCE_MS, remainingMaxWait);

  clearPendingWatcherFlushTimer();
  pendingWatcherFlushTimer = setTimeout(() => {
    void flushPendingWatcherUpdate();
  }, delay);
}

function queuePendingWatcherUpdate(
  eventType: WatcherEventType,
  provider: LLMProvider,
  updatedSessionId: string | null
): void {
  if (!pendingWatcherUpdate) {
    pendingWatcherUpdate = {
      providers: new Set<LLMProvider>(),
      changeTypes: new Set<WatcherEventType>(),
      updatedSessionIds: new Set<string>(),
    };
  }

  pendingWatcherUpdate.providers.add(provider);
  pendingWatcherUpdate.changeTypes.add(eventType);
  if (updatedSessionId) {
    pendingWatcherUpdate.updatedSessionIds.add(updatedSessionId);
  }

  schedulePendingWatcherFlush();
}

/**
 * Builds one `session_upserted` delta event for a provider-native session id.
 *
 * The event carries everything a sidebar needs to upsert the session in place
 * (session summary plus owning-project metadata), so clients never need a full
 * project-list refetch when a transcript file changes on disk. Returns `null`
 * when the id cannot be resolved to an indexed session row.
 */
async function buildSessionUpsertedEvent(updatedProviderSessionId: string): Promise<string | null> {
  const row = sessionsDb.getSessionByProviderSessionId(updatedProviderSessionId)
    ?? sessionsDb.getSessionById(updatedProviderSessionId);
  if (!row || row.isArchived) {
    return null;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  return JSON.stringify({
    kind: 'session_upserted',
    sessionId: row.session_id,
    provider: row.provider,
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
      }
      : null,
    timestamp: new Date().toISOString(),
  });
}

async function flushPendingWatcherUpdate(): Promise<void> {
  clearPendingWatcherFlushTimer();

  if (!pendingWatcherUpdate) {
    return;
  }

  if (watcherRefreshInFlight) {
    watcherRescheduleAfterRefresh = true;
    return;
  }

  const queuedUpdate = pendingWatcherUpdate;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = true;

  try {
    // Per-session deltas instead of full project snapshots: an upsert of one
    // session can never clobber unrelated client state, so the frontend needs
    // no "suppress updates while a run is active" protection logic.
    const events: string[] = [];
    for (const updatedSessionId of queuedUpdate.updatedSessionIds) {
      const event = await buildSessionUpsertedEvent(updatedSessionId);
      if (event) {
        events.push(event);
      }
    }

    if (events.length > 0) {
      connectedClients.forEach(client => {
        if (client.readyState === WS_OPEN_STATE) {
          for (const event of events) {
            client.send(event);
          }
        }
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Session watcher refresh failed while broadcasting session_upserted', { error: message });
  } finally {
    watcherRefreshInFlight = false;

    if (pendingWatcherUpdate || watcherRescheduleAfterRefresh) {
      watcherRescheduleAfterRefresh = false;
      schedulePendingWatcherFlush();
    }
  }
}

/**
 * Handles file watcher updates and triggers provider file-level synchronization.
 */
async function onUpdate(
  eventType: WatcherEventType,
  filePath: string,
  provider: LLMProvider
): Promise<void> {
  if (!isWatcherTargetFile(provider, filePath)) {
    return;
  }

  try {
    const result = await sessionSynchronizerService.synchronizeProviderFile(provider, filePath);
    if (!result.indexed) {
      return;
    }

    console.log(`Session synchronization triggered by ${eventType} event for provider "${provider}"`, {
      filePath,
      sessionId: result.sessionId,
    });

    // Index only the bytes appended since last time so a growing transcript
    // stays searchable without re-reading the whole file on every event.
    if (provider === 'claude') {
      const sessionRow = result.sessionId
        ? sessionsDb.getSessionByProviderSessionId(result.sessionId) ?? sessionsDb.getSessionById(result.sessionId)
        : null;
      try {
        await sessionIndexService.indexFileIncrementally(filePath, sessionRow?.project_path ?? null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Incremental session indexing failed', { filePath, error: message });
      }
    }

    queuePendingWatcherUpdate(eventType, provider, result.sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Session watcher sync failed for provider "${provider}"`, {
      eventType,
      filePath,
      error: message,
    });
  }
}

/**
 * Starts provider filesystem watchers and performs initial DB synchronization.
 */
export async function initializeSessionsWatcher(): Promise<void> {
  console.log('Setting up session watchers');

  const initialSync = await sessionSynchronizerService.synchronizeSessions();
  console.log('Initial session synchronization complete', {
    processedByProvider: initialSync.processedByProvider,
    failures: initialSync.failures,
  });

  // Backfill the message search index from the freshly-synced session rows.
  // Fire-and-forget so server startup is not blocked; the indexer yields the
  // event loop periodically and skips files whose recorded size is unchanged,
  // so this is cheap on every restart after the first cold run.
  void sessionIndexService
    .backfillAll()
    .then(({ indexedFiles }) => {
      console.log('Session search index backfill complete', { indexedFiles });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Session search index backfill failed', { error: message });
    });

  for (const { provider, rootPath } of getProviderWatchPaths()) {
    try {
      await fsPromises.mkdir(rootPath, { recursive: true });

      const watcher = chokidar.watch(rootPath, buildWatcherOptions());
      const coalescer = getFileEventCoalescer();

      watcher
        .on('add', (filePath: string) => {
          if (isWatcherTargetFile(provider, filePath)) {
            coalescer.push(filePath, { eventType: 'add', provider });
          }
        })
        .on('change', (filePath: string) => {
          if (isWatcherTargetFile(provider, filePath)) {
            coalescer.push(filePath, { eventType: 'change', provider });
          }
        })
        .on('error', (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Session watcher error for provider "${provider}"`, { error: message });
        });

      watchers.push(watcher);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to initialize session watcher for provider "${provider}"`, {
        rootPath,
        error: message,
      });
    }
  }
}

/**
 * Stops all active provider session watchers.
 */
export async function closeSessionsWatcher(): Promise<void> {
  clearPendingWatcherFlushTimer();
  fileEventCoalescer?.close();
  fileEventCoalescer = null;

  await Promise.all(
    watchers.map(async (watcher) => {
      try {
        await watcher.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Failed to close session watcher', { error: message });
      }
    })
  );
  watchers.length = 0;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = false;
  watcherRescheduleAfterRefresh = false;
}
