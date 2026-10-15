import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionSynchronizerService, readFirstUserMessagePreview } from '@/modules/providers/index.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';
import { AppError, deriveRepoGrouping, getPathBasename, type RepoGrouping } from '@/shared/utils.js';

const execFileAsync = promisify(execFile);

type SessionSummary = {
  id: string;
  provider: string;
  summary: string;
  messageCount: number;
  lastActivity: string;
  starred_at: string | null;
  jsonlPath: string | null;
};

type SessionRepositoryRow = {
  provider: string;
  session_id: string;
  custom_name?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  starred_at?: string | null;
  jsonl_path?: string | null;
};

export type ProjectListItem = {
  projectId: string;
  path: string;
  displayName: string;
  fullPath: string;
  isStarred: boolean;
  // Owning repository of this project path, so the sidebar can group every
  // worktree of a repo under one header. For a plain checkout `repoRoot` is the
  // project itself; for a linked worktree it is the originating repo. Resolved
  // from `git rev-parse --git-common-dir` (see resolveRepoGrouping).
  repoRoot: string;
  repoName: string;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
};

export type ArchivedProjectListItem = ProjectListItem & {
  isArchived: true;
};

type ProgressUpdate = {
  phase: 'loading' | 'complete';
  current: number;
  total: number;
  currentProject?: string;
};

type GetProjectsWithSessionsOptions = {
  skipSynchronization?: boolean;
  sessionsLimit?: number;
  sessionsOffset?: number;
};

type SessionPaginationOptions = {
  limit?: number;
  offset?: number;
};

type ProjectSessionsPageResult = {
  sessions: SessionSummary[];
  total: number;
  hasMore: boolean;
};

export type ProjectSessionsPageApiView = {
  projectId: string;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
};

const DEFAULT_PROJECT_SESSIONS_PAGE_SIZE = 20;
const MAX_PROJECT_SESSIONS_PAGE_SIZE = 200;

/**
 * Generate better display name from path.
 */
export async function generateDisplayName(projectName: string, actualProjectDir: string | null = null): Promise<string> {
  // Use actual project directory if provided, otherwise decode from project name.
  const projectPath = actualProjectDir || projectName.replace(/-/g, '/');

  // Try to read package.json from the project path.
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const packageData = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageData) as { name?: string };

    // Return the name from package.json if it exists.
    if (packageJson.name) {
      return packageJson.name;
    }
  } catch {
    // Fall back to path-based naming if package.json doesn't exist or can't be read.
  }

  // If it starts with /, it's an absolute path.
  if (projectPath.startsWith('/')) {
    const parts = projectPath.split('/').filter(Boolean);
    // Return only the last folder name.
    return parts[parts.length - 1] || projectPath;
  }

  return projectPath;
}

// A project path's owning repo does not change over a process's lifetime, so
// the git lookup is memoized to keep repeated sidebar loads from re-spawning
// one `git` per project. Both hits and misses are cached: a non-git path is
// stably its own group until the server restarts.
const repoGroupingCache = new Map<string, RepoGrouping>();

/**
 * Resolves the owning repository of a project path for sidebar grouping.
 *
 * Uses `git rev-parse --git-common-dir` — the same primitive the git route uses
 * to name a worktree's repo — so every linked worktree of a repo resolves to
 * the same `repoRoot`. Non-git paths (or paths that no longer exist) fall back
 * to being their own group, which keeps "always group" total: every project
 * lands under exactly one header.
 */
async function resolveRepoGrouping(projectPath: string): Promise<RepoGrouping> {
  const cached = repoGroupingCache.get(projectPath);
  if (cached) {
    return cached;
  }

  let grouping: RepoGrouping;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
      cwd: projectPath,
      maxBuffer: 1024 * 1024,
    });
    grouping = deriveRepoGrouping(projectPath, stdout);
  } catch {
    grouping = { repoRoot: projectPath, repoName: getPathBasename(projectPath) || projectPath };
  }

  repoGroupingCache.set(projectPath, grouping);
  return grouping;
}

function normalizeSessionPagination(options: SessionPaginationOptions = {}): { limit: number; offset: number } {
  const rawLimit = Number.isFinite(options.limit) ? Math.floor(Number(options.limit)) : DEFAULT_PROJECT_SESSIONS_PAGE_SIZE;
  const rawOffset = Number.isFinite(options.offset) ? Math.floor(Number(options.offset)) : 0;

  return {
    limit: Math.min(Math.max(1, rawLimit), MAX_PROJECT_SESSIONS_PAGE_SIZE),
    offset: Math.max(0, rawOffset),
  };
}

/**
 * Shapes one DB row into the sidebar payload.
 *
 * When a session has no cached title (`custom_name` empty — no `custom-title`
 * or `ai-title` on disk), `summary` is filled from a render-only preview of the
 * transcript's first user message. This is never persisted: it is recomputed on
 * each read, so it cannot flip-flop the way a stored fabricated name did, and it
 * keeps the DB free of names that have no matching line in the transcript.
 *
 * The preview only reads the head of the file, and only for un-named rows, so a
 * page of already-named sessions does no extra I/O.
 */
async function mapSessionRowToSummary(row: SessionRepositoryRow): Promise<SessionSummary> {
  const cachedName = row.custom_name?.trim() ?? '';
  const jsonlPath = row.jsonl_path ?? null;
  const summary = cachedName || (jsonlPath ? await readFirstUserMessagePreview(jsonlPath) : '');

  return {
    id: row.session_id,
    provider: row.provider,
    summary,
    messageCount: 0,
    lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    starred_at: row.starred_at ?? null,
    jsonlPath,
  };
}

function mapSessionRowsToSummaries(rows: SessionRepositoryRow[]): Promise<SessionSummary[]> {
  return Promise.all(rows.map(mapSessionRowToSummary));
}

async function readProjectSessionsIncludingArchived(projectPath: string): Promise<ProjectSessionsPageResult> {
  const rows = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath) as SessionRepositoryRow[];

  return {
    sessions: await mapSessionRowsToSummaries(rows),
    total: rows.length,
    hasMore: false,
  };
}

/**
 * Reads one paginated project session slice from the DB and groups rows by provider.
 */
async function readProjectSessionsPageByPath(
  projectPath: string,
  options: SessionPaginationOptions = {},
): Promise<ProjectSessionsPageResult> {
  const pagination = normalizeSessionPagination(options);
  const rows = sessionsDb.getSessionsByProjectPathPage(
    projectPath,
    pagination.limit,
    pagination.offset,
  ) as SessionRepositoryRow[];
  const total = sessionsDb.countSessionsByProjectPath(projectPath);

  return {
    sessions: await mapSessionRowsToSummaries(rows),
    total,
    hasMore: pagination.offset + rows.length < total,
  };
}

// Broadcast progress to all connected WebSocket clients.
// Uses the unified `kind` envelope like every other websocket frame.
function broadcastProgress(progress: ProgressUpdate) {
  const message = JSON.stringify({
    kind: 'loading_progress',
    ...progress,
  });

  connectedClients.forEach((client: RealtimeClientConnection) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(message);
    }
  });
}

/**
 * Reads all projects from DB and returns normalized session summaries.
 */
export async function getProjectsWithSessions(
  options: GetProjectsWithSessionsOptions = {}
): Promise<ProjectListItem[]> {
  if (!options.skipSynchronization) {
    await sessionSynchronizerService.synchronizeSessions();
  }

  const projectRows = projectsDb.getProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
  }>;
  const totalProjects = projectRows.length;
  const projects: ProjectListItem[] = [];
  let processedProjects = 0;

  // Resolve each project's owning repo in parallel up front so the sequential
  // per-project loop below (which streams progress) only reads from cache.
  await Promise.all(projectRows.map((row) => resolveRepoGrouping(row.project_path)));

  for (const row of projectRows) {
    processedProjects += 1;

    const projectId = row.project_id;
    const projectPath = row.project_path;

    broadcastProgress({
      phase: 'loading',
      current: processedProjects,
      total: totalProjects,
      currentProject: projectPath,
    });

    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : await generateDisplayName(path.basename(projectPath) || projectPath, projectPath);

    const sessionsPage = await readProjectSessionsPageByPath(projectPath, {
      limit: options.sessionsLimit,
      offset: options.sessionsOffset,
    });

    const { repoRoot, repoName } = await resolveRepoGrouping(projectPath);

    projects.push({
      projectId,
      path: projectPath,
      displayName,
      fullPath: projectPath,
      isStarred: Boolean(row.isStarred),
      repoRoot,
      repoName,
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    });
  }

  broadcastProgress({
    phase: 'complete',
    current: totalProjects,
    total: totalProjects,
  });

  return projects;
}

/**
 * Reads archived projects from DB and includes every session row for each
 * project path, because an archived workspace should surface all preserved
 * conversation history in the archive view regardless of each session's flag.
 */
export async function getArchivedProjectsWithSessions(
  options: Pick<GetProjectsWithSessionsOptions, 'skipSynchronization'> = {},
): Promise<ArchivedProjectListItem[]> {
  if (!options.skipSynchronization) {
    await sessionSynchronizerService.synchronizeSessions();
  }

  const projectRows = projectsDb.getArchivedProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
  }>;

  const archivedProjects: ArchivedProjectListItem[] = [];

  for (const row of projectRows) {
    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : await generateDisplayName(path.basename(row.project_path) || row.project_path, row.project_path);

    const sessionsPage = await readProjectSessionsIncludingArchived(row.project_path);
    const { repoRoot, repoName } = await resolveRepoGrouping(row.project_path);

    archivedProjects.push({
      projectId: row.project_id,
      path: row.project_path,
      displayName,
      fullPath: row.project_path,
      isStarred: Boolean(row.isStarred),
      repoRoot,
      repoName,
      isArchived: true,
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    });
  }

  return archivedProjects;
}

/**
 * Loads one paginated session slice for a specific project id.
 */
export async function getProjectSessionsPage(
  projectId: string,
  options: SessionPaginationOptions = {},
): Promise<ProjectSessionsPageApiView> {
  const projectRow = projectsDb.getProjectById(projectId);
  if (!projectRow) {
    throw new AppError(`Project "${projectId}" was not found.`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  const sessionsPage = await readProjectSessionsPageByPath(projectRow.project_path, options);
  return {
    projectId: projectRow.project_id,
    sessions: sessionsPage.sessions,
    sessionMeta: {
      hasMore: sessionsPage.hasMore,
      total: sessionsPage.total,
    },
  };
}
