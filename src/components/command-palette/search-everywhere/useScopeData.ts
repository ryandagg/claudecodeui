import { useCallback, useEffect, useState } from 'react';

import { api } from '../../../utils/api';
import type { LLMProvider } from '../../../types/app';

import {
  parseRecentlyViewed,
  parseScopeState,
  recordRecentlyViewed,
  type ScopeState,
} from './scopeModel';

const scopeKey = (surface: string) => `cloudcli.search.scope.${surface}`;
const RECENTLY_VIEWED_KEY = 'cloudcli.search.recentlyViewed';
const DEFAULT_SCOPE: ScopeState = { scope: 'current-project', includeArchived: false };

const readStorage = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeStorage = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage full / disabled — scope just won't persist
  }
};

/**
 * Last-used scope, remembered per surface (`dialog`, `sidebar`). This is
 * device-local UX state, not Claude config, so localStorage is the right home.
 */
export function usePersistentScope(surface: string): [ScopeState, (next: ScopeState) => void] {
  const [state, setState] = useState<ScopeState>(() => parseScopeState(readStorage(scopeKey(surface)), DEFAULT_SCOPE));
  const set = useCallback((next: ScopeState) => {
    setState(next);
    writeStorage(scopeKey(surface), JSON.stringify(next));
  }, [surface]);
  return [state, set];
}

/**
 * Most-recent-first ids of sessions the user opened, from any surface.
 * Fed by the app's selected session, so sidebar clicks count too. Inert
 * (no reads or writes) while the Search Everywhere flag is off.
 */
export function useRecentlyViewedSessions(selectedSessionId: string | null | undefined, enabled: boolean): string[] {
  const [ids, setIds] = useState<string[]>(() => (enabled ? parseRecentlyViewed(readStorage(RECENTLY_VIEWED_KEY)) : []));

  // Flipping the flag on mid-session: pick up whatever was stored before.
  useEffect(() => {
    if (enabled) setIds(parseRecentlyViewed(readStorage(RECENTLY_VIEWED_KEY)));
  }, [enabled]);

  useEffect(() => {
    // Flag off must be zero-change: no tracking, no localStorage writes.
    if (!enabled || !selectedSessionId) return;
    setIds((prev) => {
      if (prev[0] === selectedSessionId) return prev;
      const next = recordRecentlyViewed(prev, selectedSessionId);
      writeStorage(RECENTLY_VIEWED_KEY, JSON.stringify(next));
      return next;
    });
  }, [enabled, selectedSessionId]);

  return ids;
}

export type ArchivedSessionSummary = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  sessionTitle: string;
  lastActivity: string | null;
  isProjectArchived: boolean;
};

/** Archived-session list (same endpoint the sidebar's Archive view uses), fetched only while needed. */
export function useArchivedSessions(enabled: boolean): ArchivedSessionSummary[] {
  const [items, setItems] = useState<ArchivedSessionSummary[]>([]);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    api.getArchivedSessions()
      .then((r: Response) => (r.ok ? r.json() : null))
      .then((payload: { data?: { sessions?: ArchivedSessionSummary[] } } | null) => {
        if (cancelled) return;
        setItems(Array.isArray(payload?.data?.sessions) ? payload.data.sessions : []);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return enabled ? items : EMPTY;
}

const EMPTY: ArchivedSessionSummary[] = [];
