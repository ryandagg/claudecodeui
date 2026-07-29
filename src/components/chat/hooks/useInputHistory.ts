import { useCallback, useRef } from 'react';

import type { ChatMessage } from '../types/types';

/** One recallable user message: its text plus the anchors reveal uses to find it. */
export interface InputHistoryEntry {
  content: string;
  messageUuid?: string;
  timestamp?: string | number | Date;
}

/** Where reveal should scroll: the source message of the recalled text. */
export interface RevealTarget {
  uuid?: string;
  timestamp?: string | number | Date;
}

interface InputHistoryState {
  /** Position in the history array; -1 means "not navigating / live draft". */
  index: number;
  /** The in-progress text stashed on first ArrowUp, restored past the newest. */
  draft: string;
}

interface InputHistoryKeyContext {
  key: string;
  selectionStart: number;
  selectionEnd: number;
  value: string;
}

export type InputHistoryNav =
  | { handled: false }
  | {
      handled: true;
      /** Next value for the history cursor. */
      index: number;
      /** Next value for the stashed draft. */
      draft: string;
      /** Text to write into the textarea, or null to leave it untouched. */
      input: string | null;
      /** Message to scroll into view + flash, or null when nothing should move. */
      reveal: RevealTarget | null;
      /** Restore-to-draft: scroll the transcript back down to the newest message. */
      scrollToBottom: boolean;
    };

interface UseInputHistoryOptions {
  /** Scroll a recalled historical message into view and flash it. */
  onReveal?: (target: RevealTarget) => void;
  /** Return the transcript to the newest message when the draft is restored. */
  onScrollToBottom?: () => void;
}

/**
 * Pure keyboard-history state machine, factored out of the hook so it can be
 * unit-tested without a DOM. Given the pressed key, the textarea's cursor state,
 * the current cursor position in history, and the list of recallable user
 * messages, it returns what to do next: whether the key was consumed, the new
 * cursor/draft, the text to show, and whether to reveal a message or drop back
 * to the live view.
 *
 * Rules (mirrors shell prompt history):
 * - ArrowUp only at cursor position 0; first press stashes the live draft and
 *   jumps to the newest message, then walks older. At the oldest it swallows the
 *   key (no wrap) so a held key doesn't fall through to the textarea.
 * - ArrowDown only while navigating and only at the very end of the text; walks
 *   newer, and past the newest restores the stashed draft and returns to live.
 * - A collapsed selection is required (start === end) — an ArrowUp that's
 *   extending a selection must stay a caret move.
 */
export function computeInputHistoryNav(
  ctx: InputHistoryKeyContext,
  state: InputHistoryState,
  history: InputHistoryEntry[],
): InputHistoryNav {
  const { key, selectionStart, selectionEnd, value } = ctx;
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return { handled: false };
  if (selectionStart !== selectionEnd) return { handled: false };
  if (history.length === 0) return { handled: false };

  const { draft } = state;
  // Normalize a stale cursor to the "not navigating" sentinel so a history read
  // can never be undefined. An index left over from a longer session (this hook
  // outlives session switches — `ChatInterface` re-renders rather than
  // remounting) would otherwise index past the end; treating it as -1 makes the
  // next ArrowUp re-stash the draft and start from the newest message.
  const index = state.index < 0 || state.index >= history.length ? -1 : state.index;

  if (key === 'ArrowUp') {
    if (selectionStart !== 0) return { handled: false };

    let nextIndex: number;
    let nextDraft = draft;
    if (index === -1) {
      nextDraft = value;
      nextIndex = history.length - 1;
    } else if (index > 0) {
      nextIndex = index - 1;
    } else {
      // Already at the oldest message: consume the key but change nothing.
      return { handled: true, index, draft, input: null, reveal: null, scrollToBottom: false };
    }

    const entry = history[nextIndex];
    return {
      handled: true,
      index: nextIndex,
      draft: nextDraft,
      input: entry.content,
      reveal: { uuid: entry.messageUuid, timestamp: entry.timestamp },
      scrollToBottom: false,
    };
  }

  // ArrowDown.
  if (index === -1) return { handled: false };
  if (selectionStart !== value.length) return { handled: false };

  if (index < history.length - 1) {
    const nextIndex = index + 1;
    const entry = history[nextIndex];
    return {
      handled: true,
      index: nextIndex,
      draft,
      input: entry.content,
      reveal: { uuid: entry.messageUuid, timestamp: entry.timestamp },
      scrollToBottom: false,
    };
  }

  // Past the newest: restore the stashed draft and return to the live view.
  return {
    handled: true,
    index: -1,
    draft,
    input: draft,
    reveal: null,
    scrollToBottom: true,
  };
}

/**
 * Shell-style up/down prompt history navigation over the current session's user
 * messages.
 *
 * Behavior:
 * - ArrowUp at cursor position 0: navigate to previous user message.
 * - ArrowDown at cursor end while navigating: go forward; past newest → restore draft.
 * - Any manual edit should call `resetHistory`.
 *
 * As each historical message is recalled it is also scrolled into view and
 * flashed (via `onReveal`), the same way clicking a search hit reveals its
 * message; restoring the draft scrolls back to the newest message
 * (`onScrollToBottom`).
 *
 * The hook exposes `bindSetInput` — call it once after the composer state hook
 * with the composer's `setInput` and `inputValueRef` to break the circular
 * dependency (this hook needs setInput; the composer needs onHistoryKeyDown).
 */
export function useInputHistory(chatMessages: ChatMessage[], options: UseInputHistoryOptions = {}) {
  const indexRef = useRef(-1);
  const draftRef = useRef('');
  const setInputRef = useRef<((value: string) => void) | null>(null);
  const inputValueRefRef = useRef<{ current: string } | null>(null);

  // Latest reveal/scroll callbacks, kept in refs so the keydown handler's
  // identity stays tied to `chatMessages` alone (reveal changes identity every
  // time the transcript grows).
  const onRevealRef = useRef(options.onReveal);
  onRevealRef.current = options.onReveal;
  const onScrollToBottomRef = useRef(options.onScrollToBottom);
  onScrollToBottomRef.current = options.onScrollToBottom;

  const resetHistory = useCallback(() => {
    indexRef.current = -1;
  }, []);

  const handleHistoryKeyDown = useCallback(
    (event: { key: string; currentTarget: HTMLTextAreaElement }): boolean => {
      const { key, currentTarget } = event;
      const { selectionStart, selectionEnd, value } = currentTarget;

      const history: InputHistoryEntry[] = chatMessages
        .filter((m) => m.type === 'user' && m.content?.trim())
        .map((m) => ({
          content: m.content!.trim(),
          messageUuid: m.messageUuid,
          timestamp: m.timestamp,
        }));

      const nav = computeInputHistoryNav(
        { key, selectionStart, selectionEnd, value },
        { index: indexRef.current, draft: draftRef.current },
        history,
      );

      if (!nav.handled) return false;

      indexRef.current = nav.index;
      draftRef.current = nav.draft;

      if (nav.input !== null) {
        setInputRef.current?.(nav.input);
        if (inputValueRefRef.current) inputValueRefRef.current.current = nav.input;
      }

      if (nav.reveal) onRevealRef.current?.(nav.reveal);
      if (nav.scrollToBottom) onScrollToBottomRef.current?.();

      return true;
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
