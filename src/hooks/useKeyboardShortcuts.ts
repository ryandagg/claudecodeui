import { useCallback, useEffect, useReducer, useRef } from 'react';

import { useSettings } from '../contexts/SettingsContext';

// Custom, user-editable keyboard shortcuts. Bindings are stored as canonical
// strings (e.g. "mod+shift+n") in a single DB-backed setting and shared across
// hook instances via SettingsContext. `mod` is the platform-primary modifier:
// Cmd on macOS, Ctrl elsewhere.

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

const parseBindings = (raw: string | null): ShortcutBindings => {
  if (!raw) return { ...DEFAULTS };
  try {
    return sanitize(JSON.parse(raw));
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

/**
 * Read/edit the persisted keyboard-shortcut bindings. Changes are written to
 * the DB-backed settings store, which shares them across all hook instances.
 */
export function useKeyboardShortcuts() {
  const { getSetting, setSetting, ready } = useSettings();
  const [bindings, dispatch] = useReducer(reducer, undefined, () => (
    parseBindings(getSetting(STORAGE_KEY))
  ));
  const didHydrateRef = useRef(false);

  // Re-sync when settings finish loading or another instance persists a change.
  useEffect(() => {
    dispatch({ type: 'set_many', value: parseBindings(getSetting(STORAGE_KEY)) });
  }, [ready, getSetting]);

  const setBinding = useCallback((id: ShortcutActionId, binding: string) => {
    dispatch({ type: 'set', id, binding });
  }, []);

  const resetBinding = useCallback((id?: ShortcutActionId) => {
    dispatch({ type: 'reset', id });
  }, []);

  // Skip the first run so the pre-load default never clobbers the stored value.
  useEffect(() => {
    if (!didHydrateRef.current) {
      didHydrateRef.current = true;
      return;
    }
    setSetting(STORAGE_KEY, JSON.stringify(bindings));
  }, [bindings, setSetting]);

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
