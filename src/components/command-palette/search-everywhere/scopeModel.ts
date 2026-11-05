/**
 * Search scopes (#16). Preset ids mirror `SEARCH_SCOPE_PRESETS` from
 * `shared/search/query.ts` (#12) so a scope chosen here can be dropped into a
 * `SearchQuery` unchanged once the dialog adopts it.
 *
 * Until the server applies scopes (#13), the dialog scopes client-side over
 * what it already has: loaded sessions, running-session activity, star state,
 * a local recently-viewed list, and the archived-session list.
 */

export const SCOPE_PRESETS = [
  'current-project',
  'all-projects',
  'running',
  'favorites',
  'recently-viewed',
  'recently-active',
  'archived',
] as const;
export type ScopePreset = (typeof SCOPE_PRESETS)[number];

export const RECENTLY_ACTIVE_DAYS = 7;
export const RECENT_VIEWED_LIMIT = 50;

export function isScopePreset(value: unknown): value is ScopePreset {
  return typeof value === 'string' && (SCOPE_PRESETS as readonly string[]).includes(value);
}

export type ScopeState = { scope: ScopePreset; includeArchived: boolean };

/**
 * "Press the trigger again" widening, IntelliJ-style:
 * current project → all projects → all projects + archived. Any other preset
 * just turns on include-archived. Fully widened is a fixed point.
 */
export function widenScope(state: ScopeState): ScopeState {
  if (state.scope === 'current-project') return { ...state, scope: 'all-projects' };
  if (!state.includeArchived && state.scope !== 'archived') return { ...state, includeArchived: true };
  return state;
}

export type ScopeContext = {
  selectedProjectId: string | null | undefined;
  runningSessionIds: ReadonlySet<string>;
  recentlyViewedIds: readonly string[];
  now: number;
};

export type ScopedSession = {
  id: string;
  projectId: string | null | undefined;
  starred?: boolean;
  lastActivity?: string | null;
  isArchived?: boolean;
};

/** Whether a session belongs to the scope. Archived sessions need the toggle (or the archived preset). */
export function sessionInScope(session: ScopedSession, state: ScopeState, ctx: ScopeContext): boolean {
  if (state.scope === 'archived') return Boolean(session.isArchived);
  if (session.isArchived && !state.includeArchived) return false;

  switch (state.scope) {
    case 'current-project':
      return Boolean(ctx.selectedProjectId) && session.projectId === ctx.selectedProjectId;
    case 'all-projects':
      return true;
    case 'running':
      return ctx.runningSessionIds.has(session.id);
    case 'favorites':
      return Boolean(session.starred);
    case 'recently-viewed':
      return ctx.recentlyViewedIds.includes(session.id);
    case 'recently-active': {
      if (!session.lastActivity) return false;
      const t = Date.parse(session.lastActivity);
      return Number.isFinite(t) && ctx.now - t <= RECENTLY_ACTIVE_DAYS * 24 * 60 * 60 * 1000;
    }
    default:
      return true;
  }
}

/**
 * Order for scoped session lists: recently-viewed keeps view order, everything
 * else keeps input order. Stable, returns a new array.
 */
export function orderForScope<T>(
  items: readonly T[],
  state: ScopeState,
  ctx: ScopeContext,
  getId: (item: T) => string,
): T[] {
  if (state.scope !== 'recently-viewed') return [...items];
  const rank = new Map(ctx.recentlyViewedIds.map((id, i) => [id, i]));
  return [...items].sort((a, b) => (rank.get(getId(a)) ?? Infinity) - (rank.get(getId(b)) ?? Infinity));
}

/** Push `id` to the front of a recently-viewed list, deduped and capped. */
export function recordRecentlyViewed(list: readonly string[], id: string, limit = RECENT_VIEWED_LIMIT): string[] {
  if (!id) return [...list];
  return [id, ...list.filter((x) => x !== id)].slice(0, limit);
}

/** Parse a persisted recently-viewed list defensively. */
export function parseRecentlyViewed(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, RECENT_VIEWED_LIMIT) : [];
  } catch {
    return [];
  }
}

/** Parse a persisted per-surface scope; falls back to `fallback` on anything odd. */
export function parseScopeState(raw: string | null, fallback: ScopeState): ScopeState {
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as Partial<ScopeState>;
    return {
      scope: isScopePreset(value?.scope) ? value.scope : fallback.scope,
      includeArchived: typeof value?.includeArchived === 'boolean' ? value.includeArchived : fallback.includeArchived,
    };
  } catch {
    return fallback;
  }
}

/** Scope with no selected project can't be "current project"; fall back to all projects. */
export function effectiveScope(state: ScopeState, selectedProjectId: string | null | undefined): ScopeState {
  if (state.scope === 'current-project' && !selectedProjectId) return { ...state, scope: 'all-projects' };
  return state;
}
