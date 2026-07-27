import { useCallback, useEffect, useMemo, useRef } from 'react';

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

/**
 * Read the current bindings. Derived straight from the reactive `settings`
 * object rather than held in local state, so every hook instance re-renders
 * with the new value the moment any instance persists an edit. Handlers should
 * prefer this over `useKeyboardShortcuts` — it cannot write, so it can't
 * clobber stored bindings with pre-load defaults.
 */
export function useShortcutBindings(): ShortcutBindings {
  const { settings } = useSettings();
  const raw = settings[STORAGE_KEY] ?? null;
  return useMemo(() => parseBindings(raw), [raw]);
}

/**
 * Read/edit the persisted keyboard-shortcut bindings. Writes happen only in
 * response to an explicit `setBinding`/`resetBinding` call — never from an
 * effect watching state, which under StrictMode's double-invoked effects would
 * race a pre-load default against the stored value on every page load.
 */
export function useKeyboardShortcuts() {
  const { setSetting } = useSettings();
  const bindings = useShortcutBindings();

  // Persist against the freshest bindings, so back-to-back edits can't drop one.
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  const persist = useCallback((next: ShortcutBindings) => {
    bindingsRef.current = next;
    setSetting(STORAGE_KEY, JSON.stringify(next));
  }, [setSetting]);

  const setBinding = useCallback((id: ShortcutActionId, binding: string) => {
    if (!VALID_IDS.has(id) || bindingsRef.current[id] === binding) return;
    persist({ ...bindingsRef.current, [id]: binding });
  }, [persist]);

  const resetBinding = useCallback((id?: ShortcutActionId) => {
    if (!id) {
      persist({ ...DEFAULTS });
      return;
    }
    if (bindingsRef.current[id] === DEFAULTS[id]) return;
    persist({ ...bindingsRef.current, [id]: DEFAULTS[id] });
  }, [persist]);

  return { bindings, setBinding, resetBinding };
}

/**
 * Register a global keydown listener that invokes `handler` when the bound
 * shortcut for `actionId` is pressed. The handler is kept in a ref so callers
 * don't need to memoize it; the listener rebinds only when the binding or
 * `enabled` changes. Subscribes read-only to the stored bindings, so an edit in
 * the settings editor takes effect immediately without a reload.
 */
export function useShortcutHandler(
  actionId: ShortcutActionId,
  handler: () => void,
  enabled = true,
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const bindings = useShortcutBindings();
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
