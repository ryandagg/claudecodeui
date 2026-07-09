import { useCallback, useEffect, useReducer, useRef } from 'react';

// Custom, user-editable keyboard shortcuts. Bindings are stored as canonical
// strings (e.g. "mod+shift+n") in a single localStorage key and synced across
// hook instances via a CustomEvent, mirroring useUiPreferences. `mod` is the
// platform-primary modifier: Cmd on macOS, Ctrl elsewhere.

export type ShortcutActionId = 'newSessionInCurrentDir' | 'scrollToBottom';

export type ShortcutDefinition = {
  id: ShortcutActionId;
  /** i18n key for the human label, under settings:shortcuts.actions. */
  labelKey: string;
  /** i18n key for the description, under settings:shortcuts.actions. */
  descriptionKey: string;
  defaultBinding: string;
};

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  {
    id: 'newSessionInCurrentDir',
    labelKey: 'shortcuts.actions.newSessionInCurrentDir.label',
    descriptionKey: 'shortcuts.actions.newSessionInCurrentDir.description',
    defaultBinding: 'mod+shift+n',
  },
  {
    id: 'scrollToBottom',
    labelKey: 'shortcuts.actions.scrollToBottom.label',
    descriptionKey: 'shortcuts.actions.scrollToBottom.description',
    defaultBinding: 'mod+shift+j',
  },
];

export type ShortcutBindings = Record<ShortcutActionId, string>;

const STORAGE_KEY = 'keyboardShortcuts';
const SYNC_EVENT = 'keyboard-shortcuts:sync';

const ACTION_IDS = SHORTCUT_DEFINITIONS.map((d) => d.id);
const VALID_IDS = new Set<ShortcutActionId>(ACTION_IDS);

const DEFAULTS: ShortcutBindings = SHORTCUT_DEFINITIONS.reduce((acc, def) => {
  acc[def.id] = def.defaultBinding;
  return acc;
}, {} as ShortcutBindings);

const isMac = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
};

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

/**
 * Build the canonical binding string for a keyboard event, or null if only
 * modifier keys are held (so a recorder can wait for a "real" key). `mod` is
 * emitted for the platform-primary modifier so bindings are portable.
 */
export const eventToBinding = (event: KeyboardEvent): string | null => {
  if (MODIFIER_KEYS.has(event.key)) return null;

  const mac = isMac();
  const parts: string[] = [];

  // Platform-primary modifier first, then the rest in a stable order.
  if (mac ? event.metaKey : event.ctrlKey) parts.push('mod');
  if (mac ? event.ctrlKey : event.metaKey) parts.push(mac ? 'ctrl' : 'meta');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');

  let key = event.key;
  if (key === ' ') {
    key = 'space';
  } else if (key.length === 1) {
    key = key.toLowerCase();
  }
  parts.push(key);

  return parts.join('+');
};

/** True when the event exactly matches the given canonical binding. */
export const matchesBinding = (binding: string, event: KeyboardEvent): boolean => {
  const eventBinding = eventToBinding(event);
  return eventBinding !== null && eventBinding === binding;
};

/** Human-readable rendering of a binding for display, e.g. "⌘⇧N" / "Ctrl+Shift+N". */
export const formatBinding = (binding: string): string => {
  if (!binding) return '';
  const mac = isMac();
  const symbols: Record<string, string> = mac
    ? { mod: '⌘', ctrl: '⌃', meta: '⌘', alt: '⌥', shift: '⇧' }
    : { mod: 'Ctrl', ctrl: 'Ctrl', meta: 'Win', alt: 'Alt', shift: 'Shift' };
  const sep = mac ? '' : '+';

  return binding
    .split('+')
    .map((part) => {
      if (part in symbols) return symbols[part];
      if (part === 'space') return 'Space';
      if (part.length === 1) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(sep);
};

const sanitize = (raw: unknown): ShortcutBindings => {
  const result = { ...DEFAULTS };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    for (const id of ACTION_IDS) {
      const value = record[id];
      if (typeof value === 'string' && value.trim()) {
        result[id] = value;
      }
    }
  }
  return result;
};

const readInitial = (): ShortcutBindings => {
  if (typeof window === 'undefined') return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
};

type Action =
  | { type: 'set'; id: ShortcutActionId; binding: string }
  | { type: 'set_many'; value: Partial<ShortcutBindings> }
  | { type: 'reset'; id?: ShortcutActionId };

function reducer(state: ShortcutBindings, action: Action): ShortcutBindings {
  switch (action.type) {
    case 'set': {
      if (!VALID_IDS.has(action.id) || state[action.id] === action.binding) return state;
      return { ...state, [action.id]: action.binding };
    }
    case 'set_many': {
      const next = sanitize({ ...state, ...action.value });
      // Only produce a new object when something actually changed.
      const changed = ACTION_IDS.some((id) => next[id] !== state[id]);
      return changed ? next : state;
    }
    case 'reset': {
      if (action.id) {
        if (state[action.id] === DEFAULTS[action.id]) return state;
        return { ...state, [action.id]: DEFAULTS[action.id] };
      }
      return { ...DEFAULTS };
    }
    default:
      return state;
  }
}

type SyncDetail = { sourceId: string; value: ShortcutBindings };

/**
 * Read/edit the persisted keyboard-shortcut bindings. Changes are written to
 * localStorage and broadcast to other instances in the same tab.
 */
export function useKeyboardShortcuts() {
  const instanceIdRef = useRef(`keyboard-shortcuts-${Math.random().toString(36).slice(2)}`);
  const [bindings, dispatch] = useReducer(reducer, undefined, readInitial);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
    window.dispatchEvent(
      new CustomEvent<SyncDetail>(SYNC_EVENT, {
        detail: { sourceId: instanceIdRef.current, value: bindings },
      }),
    );
  }, [bindings]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || event.newValue === null) return;
      try {
        dispatch({ type: 'set_many', value: sanitize(JSON.parse(event.newValue)) });
      } catch {
        // Ignore malformed storage updates.
      }
    };

    const handleSync = (event: Event) => {
      const detail = (event as CustomEvent<SyncDetail>).detail;
      if (!detail || detail.sourceId === instanceIdRef.current) return;
      dispatch({ type: 'set_many', value: detail.value });
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(SYNC_EVENT, handleSync as EventListener);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(SYNC_EVENT, handleSync as EventListener);
    };
  }, []);

  const setBinding = useCallback((id: ShortcutActionId, binding: string) => {
    dispatch({ type: 'set', id, binding });
  }, []);

  const resetBinding = useCallback((id?: ShortcutActionId) => {
    dispatch({ type: 'reset', id });
  }, []);

  return { bindings, setBinding, resetBinding };
}

/**
 * Register a global keydown listener that invokes `handler` when the bound
 * shortcut for `actionId` is pressed. The handler is kept in a ref so callers
 * don't need to memoize it; the listener rebinds only when the binding or
 * `enabled` changes. Reads the current binding live from localStorage on each
 * mount and stays in sync via the same broadcast the editor emits.
 */
export function useShortcutHandler(
  actionId: ShortcutActionId,
  handler: () => void,
  enabled = true,
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const { bindings } = useKeyboardShortcuts();
  const binding = bindings[actionId];

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || !binding) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesBinding(binding, event)) return;
      event.preventDefault();
      handlerRef.current();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [binding, enabled]);
}
