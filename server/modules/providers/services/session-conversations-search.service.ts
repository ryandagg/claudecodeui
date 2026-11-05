import os from 'node:os';
import path from 'node:path';

import { projectsDb, searchIndexDb, sessionsDb, toFtsMatchLiteral } from '@/modules/database/index.js';
import type { SessionMatchRow } from '@/modules/database/index.js';
import { normalizeIndexPath } from '@/modules/providers/services/session-index.service.js';

import { createSearchQuery, resolveSearchDate, type SearchQuery } from '../../../../shared/search/query.js';

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

export type SearchSessionsOptions = {
  /** Max matches per page (sessions are never split across pages, so a page may run slightly over). */
  limit?: number;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string | null;
  perSessionLimit?: number;
  signal?: AbortSignal | null;
  onProjectResult?: ((update: SessionConversationSearchProgressUpdate) => void) | null;
  /** Clock for relative date tokens (`after:7d`). */
  now?: Date;
  /** IANA zone for date-only / relative / zoneless date tokens. Default UTC. */
  timeZone?: string | null;
};

export type SearchSessionsResult = {
  results: ProjectConversationResult[];
  totalMatches: number;
  query: string;
  /** Cursor for the next page, or null when exhausted. */
  nextCursor: string | null;
};

type SessionRepositoryRow = ReturnType<typeof sessionsDb.getAllSessions>[number];

const SUPPORTED_PROVIDERS = new Set<SearchableProvider>(['claude', 'codex', 'gemini']);
const MAX_MATCHES_PER_SESSION = 2;
const MIN_QUERY_LENGTH = 3;
const UNKNOWN_PROJECT_KEY = '__unknown_project__';
const SNIPPET_LENGTH = 150;
const MAX_PAGE_LIMIT = 200;

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

type ClassifiedSession = {
  /** Normalized (resolved) transcript path — the key the FTS index is matched on. */
  path: string;
  row: SearchableSessionRow;
  isProjectArchived: boolean;
};

/**
 * Single scan over every indexed session: validates provider + transcript path
 * and resolves each project's archive state once (cached). The two path→session
 * maps below are just different keep/drop predicates over this one pass, so a
 * fix to the validation or path normalization can't drift between them.
 */
function* iterateIndexedSessions(): Generator<ClassifiedSession> {
  const projectArchiveStateByPath = new Map<string, boolean>();

  for (const row of sessionsDb.getAllSessionsIncludingArchived()) {
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

    yield { path: normalizeIndexPath(rawJsonlPath), row: { ...row, provider }, isProjectArchived };
  }
}

/**
 * Whether a session passes the `archived` mode. See `SearchArchived` in
 * shared/search/query.ts: an item is archived when the session row is, or its
 * whole project is.
 */
function passesArchivedMode(mode: SearchQuery['archived'], session: ClassifiedSession): boolean {
  const isArchivedItem = session.row.isArchived === 1 || session.isProjectArchived;
  switch (mode) {
    case 'auto':
      return !session.isProjectArchived;
    case 'exclude':
      return !isArchivedItem;
    case 'include':
      return true;
    case 'only':
      return isArchivedItem;
  }
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Resolves `project:` tokens to concrete `project_path`s. A token matches a
 * project by exact path (with `~` expansion and trailing-slash tolerance), by
 * directory basename, or by custom display name — case-insensitively for the
 * names. Unresolvable include tokens resolve to nothing (so an include-only
 * query for an unknown project correctly returns no results).
 */
function resolveProjectTokens(tokens: string[], projectPaths: Iterable<string>): string[] {
  if (tokens.length === 0) return [];
  const wanted = tokens.map((token) => {
    const expanded = expandHome(token.trim());
    return {
      asPath: expanded.length > 1 ? expanded.replace(/\/+$/, '') : expanded,
      lower: token.trim().toLowerCase(),
    };
  });
  const matched: string[] = [];
  for (const projectPath of projectPaths) {
    const basename = path.basename(projectPath).toLowerCase();
    const customName = projectsDb.getProjectPath(projectPath)?.custom_project_name?.trim().toLowerCase() ?? '';
    const hit = wanted.some(
      (w) => w.asPath === projectPath || w.lower === basename || (customName !== '' && w.lower === customName),
    );
    if (hit) matched.push(projectPath);
  }
  return matched;
}

type SessionFilterPlan = {
  /** Allowed transcript path → session row. */
  sessionsByPath: Map<string, SearchableSessionRow>;
  projectInclude: string[] | null;
  projectExclude: string[];
};

/**
 * Session-level filters that the message index cannot evaluate on its own
 * (archive state lives on `sessions`/`projects`, provider and favorites on
 * `sessions`) are resolved here into an allowed transcript-path set, which the
 * repository applies in SQL next to MATCH. Project tokens become exact
 * `project_path` sets, also applied in SQL.
 *
 * Not yet applied here (owned by later issues): `paths` globs (#15),
 * `running` (#16), `in:title` (#14), match options (#17/#18).
 */
function planSessionFilters(query: SearchQuery): SessionFilterPlan {
  const sessionsByPath = new Map<string, SearchableSessionRow>();
  const projectPaths = new Set<string>();
  const providers = new Set<string>(query.providers);

  for (const session of iterateIndexedSessions()) {
    if (!passesArchivedMode(query.archived, session)) continue;
    if (providers.size > 0 && !providers.has(session.row.provider)) continue;
    if (query.favorite && !session.row.starred_at) continue;
    sessionsByPath.set(session.path, session.row);
    const projectPath = typeof session.row.project_path === 'string' ? session.row.project_path.trim() : '';
    if (projectPath) projectPaths.add(projectPath);
  }

  return {
    sessionsByPath,
    projectInclude: query.projects.include.length > 0
      ? resolveProjectTokens(query.projects.include, projectPaths)
      : null,
    projectExclude: resolveProjectTokens(query.projects.exclude, projectPaths),
  };
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const offset = Number.parseInt(cursor, 10);
  return Number.isFinite(offset) && offset > 0 && String(offset) === cursor ? offset : 0;
}

/**
 * Runs the filtered index query for one page. Rows are session-contiguous, so
 * the page is cut at the first session boundary at or after `limit` matches —
 * a session's matches never straddle two pages. One extra row beyond the
 * maximum possible page size tells us whether another page exists.
 *
 * A malformed MATCH expression (should not happen after escaping) must not
 * take down the SSE stream or the archive search; it surfaces as "no results".
 */
function queryPage(
  text: string,
  query: SearchQuery,
  plan: SessionFilterPlan,
  limit: number,
  perSessionLimit: number,
  offset: number,
  dateOptions: { now: Date; timeZone?: string },
): { rows: SessionMatchRow[]; nextOffset: number | null } {
  let fetched: SessionMatchRow[];
  try {
    fetched = searchIndexDb.searchSessionMatches({
      matchLiteral: toFtsMatchLiteral(text),
      jsonlPaths: [...plan.sessionsByPath.keys()],
      projectPaths: { include: plan.projectInclude, exclude: plan.projectExclude },
      roles: query.roles,
      after: resolveSearchDate(query.after, dateOptions),
      before: resolveSearchDate(query.before, dateOptions),
      perSessionLimit,
      limit: limit + perSessionLimit + 1,
      offset,
    });
  } catch (error) {
    console.error('Session index search failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { rows: [], nextOffset: null };
  }

  let consumed = 0;
  while (consumed < fetched.length) {
    const row = fetched[consumed];
    if (consumed >= limit && row.session_rank === 1) break;
    consumed += 1;
  }
  return {
    rows: fetched.slice(0, consumed),
    nextOffset: consumed < fetched.length ? offset + consumed : null,
  };
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
 * Unified session search: one filtered index query (filters in SQL, see
 * {@link planSessionFilters}), mapped back to session rows, grouped by project
 * in rank order, and streamed one project bucket at a time. Used by the
 * active-conversation SSE search and the archive view alike (the latter is
 * just `archived: 'only'`).
 *
 * Pagination: pass the previous page's `nextCursor` to continue. Project
 * buckets can repeat across pages (a later session in an already-seen
 * project); sessions never do.
 */
export async function searchSessions(
  query: SearchQuery,
  options: SearchSessionsOptions = {},
): Promise<SearchSessionsResult> {
  return searchSessionsSync(query, options);
}

/** Synchronous core of {@link searchSessions} (better-sqlite3 is synchronous). */
function searchSessionsSync(query: SearchQuery, options: SearchSessionsOptions = {}): SearchSessionsResult {
  const text = typeof query.text === 'string' ? query.text.trim() : '';
  const rawLimit = options.limit ?? 50;
  const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 50, MAX_PAGE_LIMIT));
  const perSessionLimit = Math.max(1, options.perSessionLimit ?? MAX_MATCHES_PER_SESSION);
  const signal = options.signal ?? null;
  const empty: SearchSessionsResult = { results: [], totalMatches: 0, query: text, nextCursor: null };

  const isAborted = () => signal?.aborted === true;
  if (text.length < MIN_QUERY_LENGTH || isAborted()) {
    return empty;
  }

  const plan = planSessionFilters(query);
  if (plan.sessionsByPath.size === 0 || (plan.projectInclude !== null && plan.projectInclude.length === 0)) {
    return empty;
  }

  const offset = decodeCursor(options.cursor);
  const { rows, nextOffset } = queryPage(
    text,
    query,
    plan,
    limit,
    perSessionLimit,
    offset,
    { now: options.now ?? new Date(), timeZone: options.timeZone ?? undefined },
  );

  if (isAborted() || rows.length === 0) {
    return empty;
  }

  const projectMetadataCache = new Map<string, ProjectMetadata>();
  const bucketByKey = new Map<string, ProjectBucket>();
  const bucketOrder: ProjectBucket[] = [];
  const resultBySessionId = new Map<string, SessionConversationResult>();
  let totalMatches = 0;

  for (const hit of rows) {
    const session = plan.sessionsByPath.get(normalizeIndexPath(hit.jsonl_path));
    if (!session) {
      continue;
    }

    const sessionId = session.session_id;
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

    const { snippet, highlights } = buildSnippet(hit.body, text);
    sessionResult.matches.push({
      role: hit.role,
      snippet,
      highlights,
      timestamp: hit.timestamp,
      provider: session.provider,
      messageUuid: hit.message_uuid,
    });
    totalMatches += 1;
  }

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
    options.onProjectResult?.({
      projectResult,
      totalMatches,
      scannedProjects,
      totalProjects,
    });
  }

  return {
    results: finalResults,
    totalMatches,
    query: text,
    nextCursor: nextOffset === null ? null : String(nextOffset),
  };
}

/**
 * Legacy entry point: raw text, first page, default (`auto`) archive handling.
 * Kept so existing callers and the `q=` SSE contract are unchanged.
 */
export async function searchConversations(
  query: string,
  limit = 50,
  onProjectResult: ((update: SessionConversationSearchProgressUpdate) => void) | null = null,
  signal: AbortSignal | null = null,
): Promise<{ results: ProjectConversationResult[]; totalMatches: number; query: string }> {
  const { results, totalMatches, query: text } = await searchSessions(
    createSearchQuery({ text: typeof query === 'string' ? query : '' }),
    { limit, onProjectResult, signal },
  );
  return { results, totalMatches, query: text };
}

/**
 * Archive-view content search: distinct sessionIds of archived items whose
 * transcript matches. Same path as {@link searchSessions} with
 * `archived: 'only'` and one match per session.
 */
function searchArchivedConversationSessionIds(query: string | SearchQuery, limit = 200): string[] {
  const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 200, MAX_PAGE_LIMIT));
  const structured = typeof query === 'string' || !query
    ? createSearchQuery({ text: typeof query === 'string' ? query : '' })
    : query;
  const { results } = searchSessionsSync(
    { ...structured, archived: 'only' },
    { limit: safeLimit, perSessionLimit: 1 },
  );
  return results.flatMap((project) => project.sessions.map((session) => session.sessionId));
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
  searchArchivedSessionIds(query: string | SearchQuery, limit = 200): string[] {
    return searchArchivedConversationSessionIds(query, limit);
  },

  /** Structured, paginated search (the unified path). */
  searchSessions(query: SearchQuery, options: SearchSessionsOptions = {}): Promise<SearchSessionsResult> {
    return searchSessions(query, options);
  },
};
