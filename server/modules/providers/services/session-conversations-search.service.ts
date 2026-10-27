import path from 'node:path';

import { projectsDb, searchIndexDb, sessionsDb, toFtsMatchLiteral } from '@/modules/database/index.js';
import type { SearchIndexHit } from '@/modules/database/index.js';
import { normalizeIndexPath } from '@/modules/providers/services/session-index.service.js';

type SearchableProvider = 'claude' | 'codex' | 'gemini';

type SearchSnippetHighlight = {
  start: number;
  end: number;
};

type SessionConversationMatch = {
  role: string;
  snippet: string;
  highlights: SearchSnippetHighlight[];
  timestamp: string | null;
  provider: SearchableProvider;
  messageUuid?: string | null;
};

type SessionConversationResult = {
  sessionId: string;
  provider: SearchableProvider;
  sessionSummary: string;
  /**
   * Whether this session is itself archived (its project is still active —
   * archived-project sessions are excluded from this search entirely). Lets the
   * sidebar flag the hit and offer an inline restore without a follow-up query.
   */
  isArchived: boolean;
  matches: SessionConversationMatch[];
};

type ProjectConversationResult = {
  projectId: string | null;
  projectName: string;
  projectDisplayName: string;
  sessions: SessionConversationResult[];
};

export type SessionConversationSearchProgressUpdate = {
  projectResult: ProjectConversationResult | null;
  totalMatches: number;
  scannedProjects: number;
  totalProjects: number;
};

type SearchSessionConversationsInput = {
  query: string;
  limit: number;
  signal?: AbortSignal;
  onProgress?: (update: SessionConversationSearchProgressUpdate) => void;
};

type SessionRepositoryRow = ReturnType<typeof sessionsDb.getAllSessions>[number];

const SUPPORTED_PROVIDERS = new Set<SearchableProvider>(['claude', 'codex', 'gemini']);
const MAX_MATCHES_PER_SESSION = 2;
const MIN_QUERY_LENGTH = 3;
const UNKNOWN_PROJECT_KEY = '__unknown_project__';
const SNIPPET_LENGTH = 150;

/**
 * The trigram index MATCH can only return whole indexed rows, not per-session
 * counts, so more rows than `limit` are pulled and then grouped/capped in
 * memory. This multiplier keeps enough candidates to fill `limit` sessions
 * even when several matches land in the same session (capped per session) or
 * in sessions that are filtered out (archived project).
 */
const INDEX_FETCH_MULTIPLIER = 20;
const INDEX_FETCH_CAP = 5000;

function makeProjectKey(projectPath: string | null): string {
  const normalized = typeof projectPath === 'string' ? projectPath.trim() : '';
  return normalized.length > 0 ? normalized : UNKNOWN_PROJECT_KEY;
}

function toSummaryText(customName: string | null, fallback: string | null | undefined, emptyLabel: string): string {
  const trimmedCustomName = typeof customName === 'string' ? customName.trim() : '';
  if (trimmedCustomName) {
    return trimmedCustomName;
  }

  const trimmedFallback = typeof fallback === 'string' ? fallback.trim() : '';
  if (!trimmedFallback) {
    return emptyLabel;
  }

  return trimmedFallback.length > 50 ? `${trimmedFallback.slice(0, 50)}...` : trimmedFallback;
}

/**
 * Session rows keyed by their normalized transcript path.
 *
 * Archived sessions are searchable: archiving hides a session from the active
 * sidebar list, but its transcript is still the user's history, so a string
 * copied out of an archived conversation must be findable. Sessions belonging
 * to an archived *project* stay excluded — archiving a whole workspace removes
 * it from view, and its sessions are reachable through the archive view.
 */
type SearchableSessionRow = SessionRepositoryRow & { provider: SearchableProvider };

function buildVisibleSessionsByPath(): Map<string, SearchableSessionRow> {
  const rows = sessionsDb.getAllSessionsIncludingArchived();
  const byPath = new Map<string, SearchableSessionRow>();
  const projectArchiveStateByPath = new Map<string, boolean>();

  for (const row of rows) {
    const provider = row.provider as SearchableProvider;
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      continue;
    }

    const rawJsonlPath = typeof row.jsonl_path === 'string' ? row.jsonl_path.trim() : '';
    if (!rawJsonlPath) {
      continue;
    }

    const normalizedProjectPath = typeof row.project_path === 'string' ? row.project_path.trim() : '';
    if (normalizedProjectPath) {
      if (!projectArchiveStateByPath.has(normalizedProjectPath)) {
        const projectRow = projectsDb.getProjectPath(normalizedProjectPath);
        projectArchiveStateByPath.set(normalizedProjectPath, Boolean(projectRow?.isArchived));
      }
      if (projectArchiveStateByPath.get(normalizedProjectPath) === true) {
        continue;
      }
    }

    byPath.set(normalizeIndexPath(rawJsonlPath), { ...row, provider });
  }

  return byPath;
}

/**
 * Transcript-path → sessionId for every *archived* session, so the archive
 * view can search message bodies and not just titles/paths.
 *
 * This is the mirror image of {@link buildVisibleSessionsByPath}: it keeps the
 * items that one drops. An item counts as archived when the session row itself
 * is archived, or when its whole project is archived — both are surfaced in the
 * sidebar's archive view and so must be reachable by content there.
 */
function buildArchivedSessionIdsByPath(): Map<string, string> {
  const rows = sessionsDb.getAllSessionsIncludingArchived();
  const byPath = new Map<string, string>();
  const projectArchiveStateByPath = new Map<string, boolean>();

  for (const row of rows) {
    const provider = row.provider as SearchableProvider;
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      continue;
    }

    const rawJsonlPath = typeof row.jsonl_path === 'string' ? row.jsonl_path.trim() : '';
    if (!rawJsonlPath) {
      continue;
    }

    let isProjectArchived = false;
    const normalizedProjectPath = typeof row.project_path === 'string' ? row.project_path.trim() : '';
    if (normalizedProjectPath) {
      if (!projectArchiveStateByPath.has(normalizedProjectPath)) {
        const projectRow = projectsDb.getProjectPath(normalizedProjectPath);
        projectArchiveStateByPath.set(normalizedProjectPath, Boolean(projectRow?.isArchived));
      }
      isProjectArchived = projectArchiveStateByPath.get(normalizedProjectPath) === true;
    }

    if (row.isArchived !== 1 && !isProjectArchived) {
      continue;
    }

    byPath.set(normalizeIndexPath(rawJsonlPath), row.session_id);
  }

  return byPath;
}

/**
 * Runs the same FTS index as {@link searchConversations}, but scoped to
 * archived items, and returns the distinct sessionIds whose transcript content
 * matches. The archive view unions these with its metadata (title/path) filter
 * so a string copied out of an archived conversation is findable there too.
 */
function searchArchivedConversationSessionIds(query: string, limit = 200): string[] {
  const safeQuery = typeof query === 'string' ? query.trim() : '';
  const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 200, 1000));

  if (safeQuery.length < MIN_QUERY_LENGTH) {
    return [];
  }

  const archivedByPath = buildArchivedSessionIdsByPath();
  if (archivedByPath.size === 0) {
    return [];
  }

  const fetchLimit = Math.min(INDEX_FETCH_CAP, safeLimit * INDEX_FETCH_MULTIPLIER);
  let hits: SearchIndexHit[];
  try {
    hits = searchIndexDb.search(toFtsMatchLiteral(safeQuery), fetchLimit);
  } catch (error) {
    console.error('Archived session index search failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const seen = new Set<string>();
  const sessionIds: string[] = [];
  for (const hit of hits) {
    if (sessionIds.length >= safeLimit) {
      break;
    }
    const sessionId = archivedByPath.get(normalizeIndexPath(hit.jsonl_path));
    if (!sessionId || seen.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);
    sessionIds.push(sessionId);
  }

  return sessionIds;
}

type ProjectMetadata = { projectId: string | null; projectDisplayName: string };

function resolveProjectMetadata(
  projectKey: string,
  cache: Map<string, ProjectMetadata>,
): ProjectMetadata {
  if (cache.has(projectKey)) {
    return cache.get(projectKey) as ProjectMetadata;
  }

  let metadata: ProjectMetadata;
  if (projectKey === UNKNOWN_PROJECT_KEY) {
    metadata = { projectId: null, projectDisplayName: 'Unknown Project' };
  } else {
    const projectRow = projectsDb.getProjectPath(projectKey);
    const customProjectName = typeof projectRow?.custom_project_name === 'string'
      ? projectRow.custom_project_name.trim()
      : '';
    metadata = {
      projectId: projectRow?.project_id ?? null,
      projectDisplayName: customProjectName || path.basename(projectKey) || projectKey,
    };
  }

  cache.set(projectKey, metadata);
  return metadata;
}

/**
 * Builds a snippet window around the first occurrence of the query, with
 * character-offset highlights over every case-insensitive occurrence of the
 * (whole) query string. Offsets are relative to the returned snippet, matching
 * what the frontend `<mark>` renderer expects.
 */
function buildSnippet(
  text: string,
  needle: string,
): { snippet: string; highlights: SearchSnippetHighlight[] } {
  const normalizedNeedle = needle.trim();
  const textLower = text.toLowerCase();
  const needleLower = normalizedNeedle.toLowerCase();

  let firstIndex = needleLower ? textLower.indexOf(needleLower) : -1;
  const needleLen = normalizedNeedle.length;
  if (firstIndex === -1) {
    firstIndex = 0;
  }

  const halfLen = Math.floor(SNIPPET_LENGTH / 2);
  const start = Math.max(0, firstIndex - halfLen);
  const end = Math.min(text.length, firstIndex + halfLen + needleLen);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  const snippetBody = text.slice(start, end).replace(/\n/g, ' ');
  const snippet = `${prefix}${snippetBody}${suffix}`;

  const highlights: SearchSnippetHighlight[] = [];
  if (needleLower) {
    const snippetLower = snippet.toLowerCase();
    let from = 0;
    let idx = snippetLower.indexOf(needleLower, from);
    while (idx !== -1) {
      highlights.push({ start: idx, end: idx + needleLen });
      from = idx + needleLen;
      idx = snippetLower.indexOf(needleLower, from);
    }
  }

  return { snippet, highlights };
}

type ProjectBucket = {
  key: string;
  projectId: string | null;
  projectName: string;
  projectDisplayName: string;
  sessions: SessionConversationResult[];
};

/**
 * Core search: query the FTS index, map hits back to visible session rows,
 * group by project, cap per session and overall, and stream project buckets as
 * they complete. Preserves the SSE contract of the previous ripgrep-based
 * implementation (same result/progress shapes, project grouping, and limits).
 */
export async function searchConversations(
  query: string,
  limit = 50,
  onProjectResult: ((update: SessionConversationSearchProgressUpdate) => void) | null = null,
  signal: AbortSignal | null = null,
): Promise<{ results: ProjectConversationResult[]; totalMatches: number; query: string }> {
  const safeQuery = typeof query === 'string' ? query.trim() : '';
  const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 50, 200));

  const isAborted = () => signal?.aborted === true;

  if (safeQuery.length < MIN_QUERY_LENGTH || isAborted()) {
    return { results: [], totalMatches: 0, query: safeQuery };
  }

  const visibleSessionsByPath = buildVisibleSessionsByPath();
  if (visibleSessionsByPath.size === 0) {
    return { results: [], totalMatches: 0, query: safeQuery };
  }

  const fetchLimit = Math.min(INDEX_FETCH_CAP, safeLimit * INDEX_FETCH_MULTIPLIER);
  let hits: SearchIndexHit[];
  try {
    hits = searchIndexDb.search(toFtsMatchLiteral(safeQuery), fetchLimit);
  } catch (error) {
    // A malformed MATCH expression (should not happen after escaping) must not
    // take down the SSE stream; surface as "no results" instead.
    console.error('Session index search failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { results: [], totalMatches: 0, query: safeQuery };
  }

  if (isAborted() || hits.length === 0) {
    return { results: [], totalMatches: 0, query: safeQuery };
  }

  // Group hits into project buckets in bm25 rank order, capping matches per
  // session and stopping once `safeLimit` total matches are collected.
  const projectMetadataCache = new Map<string, ProjectMetadata>();
  const bucketByKey = new Map<string, ProjectBucket>();
  const bucketOrder: ProjectBucket[] = [];
  const resultBySessionId = new Map<string, SessionConversationResult>();
  const matchCountBySessionId = new Map<string, number>();
  let totalMatches = 0;

  for (const hit of hits) {
    if (totalMatches >= safeLimit) {
      break;
    }

    const session = visibleSessionsByPath.get(normalizeIndexPath(hit.jsonl_path));
    if (!session) {
      continue;
    }

    const sessionId = session.session_id;
    const currentCount = matchCountBySessionId.get(sessionId) ?? 0;
    if (currentCount >= MAX_MATCHES_PER_SESSION) {
      continue;
    }

    const projectKey = makeProjectKey(session.project_path);
    let bucket = bucketByKey.get(projectKey);
    if (!bucket) {
      const metadata = resolveProjectMetadata(projectKey, projectMetadataCache);
      bucket = {
        key: projectKey,
        projectId: metadata.projectId,
        projectName: projectKey,
        projectDisplayName: metadata.projectDisplayName,
        sessions: [],
      };
      bucketByKey.set(projectKey, bucket);
      bucketOrder.push(bucket);
    }

    let sessionResult = resultBySessionId.get(sessionId);
    if (!sessionResult) {
      sessionResult = {
        sessionId,
        provider: session.provider,
        sessionSummary: toSummaryText(session.custom_name ?? null, hit.body, 'New Session'),
        isArchived: session.isArchived === 1,
        matches: [],
      };
      resultBySessionId.set(sessionId, sessionResult);
      bucket.sessions.push(sessionResult);
    }

    const { snippet, highlights } = buildSnippet(hit.body, safeQuery);
    sessionResult.matches.push({
      role: hit.role,
      snippet,
      highlights,
      timestamp: hit.timestamp,
      provider: session.provider,
      messageUuid: hit.message_uuid,
    });
    matchCountBySessionId.set(sessionId, currentCount + 1);
    totalMatches += 1;
  }

  // Drop empty buckets (possible if every hit for a bucket was filtered), then
  // stream each completed project bucket, mirroring the previous progressive UI.
  const results = bucketOrder.filter((bucket) => bucket.sessions.length > 0);
  const totalProjects = results.length;
  const finalResults: ProjectConversationResult[] = [];
  let scannedProjects = 0;

  for (const bucket of results) {
    const projectResult: ProjectConversationResult = {
      projectId: bucket.projectId,
      projectName: bucket.projectName,
      projectDisplayName: bucket.projectDisplayName,
      sessions: bucket.sessions,
    };
    finalResults.push(projectResult);
    scannedProjects += 1;
    onProjectResult?.({
      projectResult,
      totalMatches,
      scannedProjects,
      totalProjects,
    });
  }

  return { results: finalResults, totalMatches, query: safeQuery };
}

/**
 * Application service for session-conversation search.
 *
 * Provider routes call this service so route handlers stay focused on
 * request parsing/response formatting, while search execution remains
 * centralized in one place.
 */
export const sessionConversationsSearchService = {
  /**
   * Streams progress updates while the search scans provider session logs.
   */
  async search(input: SearchSessionConversationsInput): Promise<void> {
    await searchConversations(
      input.query,
      input.limit,
      input.onProgress ?? null,
      input.signal ?? null,
    );
  },

  /**
   * Returns the ids of archived sessions whose transcript content matches the
   * query. Synchronous (better-sqlite3) and small by nature, so the route does
   * not need the SSE streaming the active-conversation search uses.
   */
  searchArchivedSessionIds(query: string, limit = 200): string[] {
    return searchArchivedConversationSessionIds(query, limit);
  },
};
