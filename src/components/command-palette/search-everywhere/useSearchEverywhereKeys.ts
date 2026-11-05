import { useEffect, useRef } from 'react';

import { eventToBinding } from '../../../hooks/useKeyboardShortcuts';

import {
  createDoubleShiftDetector,
  isTypingTarget,
  tabForBinding,
  type SearchTabDefinition,
  type SearchTabId,
} from './searchEverywhereModel';

type Handlers = {
  /** Cmd/Ctrl+K: toggle on the All tab. */
  onToggle: () => void;
  /** Double-Shift or a per-tab shortcut: open (or switch) to `tab`. */
  onOpenTab: (tab: SearchTabId) => void;
};

/**
 * Global triggers for the Search Everywhere dialog. Listens on `window` in the
 * capture phase so handlers further down (chat composer, xterm) can't swallow
 * the gesture before we see it — but double-Shift still bails when the user is
 * typing in an input, the shell, or the code editor.
 */
export function useSearchEverywhereTriggers(
  tabs: readonly SearchTabDefinition[],
  enabled: boolean,
  handlers: Handlers,
) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    if (!enabled) return undefined;
    const feed = createDoubleShiftDetector();

    const onKeyDown = (e: KeyboardEvent) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k';
      if (isCmdK) {
        e.preventDefault();
        handlersRef.current.onToggle();
        feed({ type: 'keydown', key: e.key, timeStamp: e.timeStamp, repeat: e.repeat });
        return;
      }

      const tab = tabForBinding(tabsRef.current, eventToBinding(e));
      if (tab) {
        e.preventDefault();
        handlersRef.current.onOpenTab(tab);
      }
      feed({ type: 'keydown', key: e.key, timeStamp: e.timeStamp, repeat: e.repeat });
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const fired = feed({ type: 'keyup', key: e.key, timeStamp: e.timeStamp });
      if (!fired) return;
      const inDialog = e.target instanceof Element && e.target.closest('[data-search-everywhere]');
      if (inDialog) return; // already open; #16 makes this "widen scope"
      if (isTypingTarget(e.target)) return;
      handlersRef.current.onOpenTab('all');
    };

    // Losing focus mid-gesture (e.g. Shift then Cmd+Tab away) must not leave a
    // half-recorded tap that completes on return.
    const onBlur = () => feed({ type: 'keydown', key: 'Unidentified', timeStamp: 0 });

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [enabled]);
}

type InDialogHandlers = {
  onCycle: (direction: 1 | -1) => void;
  onJump: (edge: 'first' | 'last') => void;
};

/**
 * In-dialog keyboard model: Tab / Shift+Tab cycle tabs, Cmd/Ctrl+Up/Down jump
 * to the first/last result. Registered on `window` capture so it runs before
 * the Dialog's document-level focus trap, which would otherwise eat Tab.
 */
export function useSearchEverywhereDialogKeys(open: boolean, handlers: InDialogHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        handlersRef.current.onCycle(e.shiftKey ? -1 : 1);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        e.stopPropagation();
        handlersRef.current.onJump(e.key === 'ArrowUp' ? 'first' : 'last');
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);
}
