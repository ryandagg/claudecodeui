import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../utils/api';
import type { ReactionType } from '../view/subcomponents/MessageReactions';

type ReactionRecord = {
  id: number;
  session_id: string;
  message_index: number;
  message_role: string;
  message_content: string | null;
  reaction: ReactionType;
  created_at: string;
};

export function useMessageReactions(sessionId: string | null) {
  const [reactions, setReactions] = useState<Map<number, ReactionRecord>>(new Map());
  const loadedSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId || sessionId === loadedSessionRef.current) return;
    loadedSessionRef.current = sessionId;

    api.reactions.forSession(sessionId).then(async (res) => {
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && Array.isArray(data.reactions)) {
        const map = new Map<number, ReactionRecord>();
        for (const r of data.reactions) {
          map.set(r.message_index, r);
        }
        setReactions(map);
      }
    }).catch(() => {});
  }, [sessionId]);

  const addReaction = useCallback(async (
    messageIndex: number,
    messageRole: string,
    messageContent: string | null,
    reaction: ReactionType,
  ) => {
    if (!sessionId) return;
    const res = await api.reactions.add(sessionId, messageIndex, messageRole, messageContent, reaction);
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && data.reaction) {
      setReactions(prev => {
        const next = new Map(prev);
        next.set(messageIndex, data.reaction);
        return next;
      });
    }
  }, [sessionId]);

  const removeReaction = useCallback(async (id: number, messageIndex: number) => {
    const res = await api.reactions.remove(id);
    if (!res.ok) return;
    const data = await res.json();
    if (data.success) {
      setReactions(prev => {
        const next = new Map(prev);
        next.delete(messageIndex);
        return next;
      });
    }
  }, []);

  const getReaction = useCallback((messageIndex: number) => {
    return reactions.get(messageIndex) ?? null;
  }, [reactions]);

  return { reactions, addReaction, removeReaction, getReaction };
}
