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
    // Cmd+Ctrl is far less contested than Cmd+Shift, which browsers have
    // largely claimed (⌘⇧N is Chrome's New Incognito Window).
    defaultBinding: 'mod+ctrl+n',
  },
  {
    id: 'scrollToBottom',
    labelKey: 'shortcuts.actions.scrollToBottom.label',
    descriptionKey: 'shortcuts.actions.scrollToBottom.description',
    defaultBinding: 'mod+alt+b',
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

// Physical keys whose `event.code` name isn't the character it prints. Using the
// printed character keeps bindings readable ("mod+alt+/") without reintroducing
// layout dependence, since the code is what we actually matched on.
const PUNCTUATION_CODES: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
};

/**
 * Canonical key token for a physical key. Derived from `event.code` rather than
 * `event.key`, so a binding records the key the user pressed instead of the
 * character their layout produced — Option+B is "b", not the "∫" macOS emits.
 */
const keyTokenFromCode = (code: string): string | null => {
  if (!code) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (code === 'Space') return 'space';
  if (code in PUNCTUATION_CODES) return PUNCTUATION_CODES[code];
  return code.toLowerCase();
};

/**
 * Build the canonical binding string for a keyboard event, or null if only
 * modifier keys are held (so a recorder can wait for a "real" key). `mod` is
 * emitted for the platform-primary modifier so bindings are portable.
 */
export const eventToBinding = (event: KeyboardEvent): string | null => {
  if (MODIFIER_KEYS.has(event.key)) return null;

  // Synthetic events may carry no code; fall back so we never store an empty key.
  const key = keyTokenFromCode(event.code)
    ?? (event.key === ' ' ? 'space' : event.key.toLowerCase());
  if (!key) return null;

  const mac = isMac();
  const parts: string[] = [];

  // Platform-primary modifier first, then the rest in a stable order.
  if (mac ? event.metaKey : event.ctrlKey) parts.push('mod');
  if (mac ? event.ctrlKey : event.metaKey) parts.push(mac ? 'ctrl' : 'meta');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(key);

  return parts.join('+');
};

/** True when the event exactly matches the given canonical binding. */
export const matchesBinding = (binding: string, event: KeyboardEvent): boolean => {
  const eventBinding = eventToBinding(event);
  return eventBinding !== null && eventBinding === binding;
};

// `event.code` names lowercased by keyTokenFromCode, mapped back to readable
// labels so a bound arrow or Enter doesn't render as "Arrowdown".
const KEY_LABELS: Record<string, string> = {
  space: 'Space',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: 'Enter',
  numpadenter: 'Enter',
  escape: 'Esc',
  backspace: 'Backspace',
  delete: 'Delete',
  tab: 'Tab',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
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
      if (part in KEY_LABELS) return KEY_LABELS[part];
      if (/^f([1-9]|1[0-9]|2[0-4])$/.test(part)) return part.toUpperCase();
      if (part.length === 1) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(sep);
};

/**
 * Bindings recorded before we switched to `event.code` stored whatever character
 * the layout produced, so macOS Option combos were saved as dead keys ("∫" for
 * Option+B). Those can't be mapped back to a physical key without a per-layout
 * table, and they can never match again, so treat them as unset and let the
 * action fall back to its default.
 */
const isMatchableBinding = (binding: string): boolean => {
  const key = binding.split('+').pop() ?? '';
  return key.length > 0 && !/[^\x20-\x7e]/.test(key);
};

const sanitize = (raw: unknown): ShortcutBindings => {
  const result = { ...DEFAULTS };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    for (const id of ACTION_IDS) {
      const value = record[id];
      if (typeof value === 'string' && value.trim() && isMatchableBinding(value)) {
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

  /**
   * Assign a binding, refusing combos already held by another action. Returns the
   * conflicting action's id so the caller can surface it, or null on success —
   * rejecting here (rather than warning after the fact) keeps two actions from
   * ever being persisted on the same combo, where only one could win.
   */
  const setBinding = useCallback((
    id: ShortcutActionId,
    binding: string,
  ): ShortcutActionId | null => {
    if (!VALID_IDS.has(id)) return null;
    if (bindingsRef.current[id] === binding) return null;

    const taken = ACTION_IDS.find((other) => (
      other !== id && bindingsRef.current[other] === binding
    ));
    if (taken) return taken;

    persist({ ...bindingsRef.current, [id]: binding });
    return null;
  }, [persist]);

  const resetBinding = useCallback((id?: ShortcutActionId) => {
    if (!id) {
      persist({ ...DEFAULTS });
      return;
    }
    if (bindingsRef.current[id] === DEFAULTS[id]) return;

    // Reset must always succeed, so when another action has since taken this
    // one's default, send it back to its own default too. DEFAULTS are unique,
    // so that always lands on a conflict-free state.
    const next = { ...bindingsRef.current, [id]: DEFAULTS[id] };
    for (const other of ACTION_IDS) {
      if (other !== id && next[other] === DEFAULTS[id]) {
        next[other] = DEFAULTS[other];
      }
    }
    persist(next);
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
