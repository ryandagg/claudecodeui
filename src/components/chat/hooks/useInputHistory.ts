import { useCallback, useRef } from 'react';
import type { ChatMessage } from '../types/types';

/**
 * Shell-style up/down prompt history navigation over the current session's user
 * messages.
 *
 * Behavior:
 * - ArrowUp at cursor position 0: navigate to previous user message.
 * - ArrowDown at cursor end while navigating: go forward; past newest → restore draft.
 * - Any manual edit should call `resetHistory`.
 *
 * The hook exposes `bindSetInput` — call it once after the composer state hook
 * with the composer's `setInput` and `inputValueRef` to break the circular
 * dependency (this hook needs setInput; the composer needs onHistoryKeyDown).
 */
export function useInputHistory(chatMessages: ChatMessage[]) {
  const indexRef = useRef(-1);
  const draftRef = useRef('');
  const setInputRef = useRef<((value: string) => void) | null>(null);
  const inputValueRefRef = useRef<{ current: string } | null>(null);

  const resetHistory = useCallback(() => {
    indexRef.current = -1;
  }, []);

  const handleHistoryKeyDown = useCallback(
    (event: { key: string; currentTarget: HTMLTextAreaElement }): boolean => {
      const { key, currentTarget } = event;
      if (key !== 'ArrowUp' && key !== 'ArrowDown') return false;

      const { selectionStart, selectionEnd, value } = currentTarget;
      if (selectionStart !== selectionEnd) return false;

      const userMessages = chatMessages
        .filter((m) => m.type === 'user' && m.content?.trim())
        .map((m) => m.content!.trim());

      if (userMessages.length === 0) return false;

      if (key === 'ArrowUp') {
        if (selectionStart !== 0) return false;

        if (indexRef.current === -1) {
          draftRef.current = value;
          indexRef.current = userMessages.length - 1;
        } else if (indexRef.current > 0) {
          indexRef.current -= 1;
        } else {
          return true;
        }

        const next = userMessages[indexRef.current];
        setInputRef.current?.(next);
        if (inputValueRefRef.current) inputValueRefRef.current.current = next;
        return true;
      }

      if (key === 'ArrowDown') {
        if (indexRef.current === -1) return false;
        if (selectionStart !== value.length) return false;

        let next: string;
        if (indexRef.current < userMessages.length - 1) {
          indexRef.current += 1;
          next = userMessages[indexRef.current];
        } else {
          indexRef.current = -1;
          next = draftRef.current;
        }
        setInputRef.current?.(next);
        if (inputValueRefRef.current) inputValueRefRef.current.current = next;
        return true;
      }

      return false;
    },
    [chatMessages],
  );

  const bindSetInput = useCallback(
    (setInput: (value: string) => void, inputValueRef: { current: string }) => {
      setInputRef.current = setInput;
      inputValueRefRef.current = inputValueRef;
    },
    [],
  );

  return { handleHistoryKeyDown, resetHistory, bindSetInput };
}
