import { useEffect, useState } from 'react';

import { api } from '../../../utils/api';

import type { MessageHit } from './searchEverywhereModel';

type ProjectResult = {
  projectId: string | null;
  projectName: string;
  projectDisplayName?: string;
  sessions: Array<{
    sessionId: string;
    provider: string;
    sessionSummary: string;
    isArchived?: boolean;
    matches: Array<{
      role: string;
      snippet: string;
      highlights?: Array<{ start: number; end: number }>;
      timestamp: string | null;
      messageUuid?: string | null;
    }>;
  }>;
};

// Trigram FTS needs ≥3 chars; shorter queries can't match the index.
export const MIN_MESSAGE_QUERY = 3;
const DEBOUNCE_MS = 250;
const LIMIT = 100;

/**
 * Server-side message search across every project (the sidebar's
 * conversation-search SSE stream), flattened into one hit per matched
 * message. Results stream in per project; a new query closes the old stream.
 */
export function useMessageHits(query: string, enabled: boolean) {
  const [hits, setHits] = useState<MessageHit[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || trimmed.length < MIN_MESSAGE_QUERY) {
      setHits([]);
      setLoading(false);
      return undefined;
    }

    let es: EventSource | null = null;
    let cancelled = false;
    setLoading(true);

    const handle = setTimeout(() => {
      es = new EventSource(api.searchConversationsUrl(trimmed, LIMIT));
      const accumulated: MessageHit[] = [];

      es.addEventListener('result', (evt) => {
        if (cancelled) return;
        try {
          const data = JSON.parse((evt as MessageEvent).data) as { projectResult: ProjectResult | null };
          const pr = data.projectResult;
          if (!pr) return;
          for (const s of pr.sessions) {
            for (const m of s.matches) {
              accumulated.push({
                projectId: pr.projectId,
                projectName: pr.projectDisplayName || pr.projectName,
                sessionId: s.sessionId,
                provider: s.provider,
                sessionSummary: s.sessionSummary || s.sessionId,
                isArchived: Boolean(s.isArchived),
                snippet: m.snippet,
                highlights: m.highlights ?? [],
                role: m.role,
                timestamp: m.timestamp,
                messageUuid: m.messageUuid ?? null,
              });
            }
          }
          setHits([...accumulated]);
        } catch {
          // ignore malformed frames
        }
      });

      const finish = () => {
        es?.close();
        if (!cancelled) setLoading(false);
      };
      es.addEventListener('done', finish);
      es.addEventListener('error', finish);
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(handle);
      es?.close();
    };
  }, [query, enabled]);

  return { hits, loading };
}
