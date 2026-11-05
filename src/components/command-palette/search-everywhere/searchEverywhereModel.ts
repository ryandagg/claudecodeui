/**
 * Pure model for the Search Everywhere dialog (#20): tab registry, the
 * keyboard model (Tab cycling, per-tab shortcuts, double-Shift), the feature
 * flag, interim text filtering, and the payload that opens a message hit at
 * the matched message. No React and no DOM globals beyond what callers pass
 * in, so all of it runs under `node:test`.
 */

export const SEARCH_EVERYWHERE_FLAG_KEY = 'cloudcli.flags.searchEverywhere';

type FlagStorage = Pick<Storage, 'getItem'>;

/** Flag is OFF unless explicitly set to a truthy string ("1"/"true"/"on"). */
export function isSearchEverywhereEnabled(storage: FlagStorage | null | undefined): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(SEARCH_EVERYWHERE_FLAG_KEY);
    if (!raw) return false;
    return ['1', 'true', 'on', 'yes'].includes(raw.trim().toLowerCase());
  } catch {
    return false;
  }
}

export type SearchTabId = 'all' | 'sessions' | 'messages' | 'files' | 'text' | 'actions' | 'git';

export type SearchTabDefinition = {
  id: SearchTabId;
  /** i18n key under common:searchEverywhere.tabs */
  labelKey: string;
  defaultLabel: string;
  /**
   * Global binding (see useKeyboardShortcuts canonical format) that opens the
   * dialog straight on this tab, or switches to it while open. Kept off the
   * browser-reserved Cmd+Shift / Cmd+N space; becomes user-configurable in #29.
   */
  shortcut?: string;
};

export const SEARCH_TABS: readonly SearchTabDefinition[] = [
  { id: 'all', labelKey: 'searchEverywhere.tabs.all', defaultLabel: 'All' },
  { id: 'sessions', labelKey: 'searchEverywhere.tabs.sessions', defaultLabel: 'Sessions', shortcut: 'mod+alt+s' },
  { id: 'messages', labelKey: 'searchEverywhere.tabs.messages', defaultLabel: 'Messages', shortcut: 'mod+alt+e' },
  { id: 'files', labelKey: 'searchEverywhere.tabs.files', defaultLabel: 'Files', shortcut: 'mod+alt+o' },
  { id: 'text', labelKey: 'searchEverywhere.tabs.text', defaultLabel: 'Text', shortcut: 'mod+alt+t' },
  { id: 'actions', labelKey: 'searchEverywhere.tabs.actions', defaultLabel: 'Actions', shortcut: 'mod+alt+a' },
  { id: 'git', labelKey: 'searchEverywhere.tabs.git', defaultLabel: 'Git', shortcut: 'mod+alt+g' },
];

/**
 * Tabs whose data source exists today. `text` (file-content search) lands with
 * #23; until then it's registered (so shortcuts/config know it) but hidden.
 */
export function visibleTabs(available: ReadonlySet<SearchTabId>): SearchTabDefinition[] {
  return SEARCH_TABS.filter((tab) => available.has(tab.id));
}

/** Next/previous tab with wrap-around. Unknown current → first tab. */
export function cycleTab(
  tabs: readonly SearchTabDefinition[],
  current: SearchTabId,
  direction: 1 | -1,
): SearchTabId {
  if (tabs.length === 0) return current;
  const index = tabs.findIndex((tab) => tab.id === current);
  if (index === -1) return tabs[0].id;
  const next = (index + direction + tabs.length) % tabs.length;
  return tabs[next].id;
}

/** The tab whose shortcut matches `binding`, among the visible tabs. */
export function tabForBinding(
  tabs: readonly SearchTabDefinition[],
  binding: string | null,
): SearchTabId | null {
  if (!binding) return null;
  return tabs.find((tab) => tab.shortcut === binding)?.id ?? null;
}

// ---------------------------------------------------------------------------
// Double-Shift
// ---------------------------------------------------------------------------

export type KeyLike =
  | { type: 'keydown' | 'keyup'; key: string; repeat?: boolean; timeStamp: number }
  /** Any pointer press (click, tap). Pressed with Shift held it makes Shift a modifier. */
  | { type: 'pointerdown'; timeStamp: number }
  /** Window lost focus: forget everything, keyups may never arrive. */
  | { type: 'reset'; timeStamp: number };

export const DOUBLE_SHIFT_WINDOW_MS = 400;
/** A Shift held longer than this is a hold, not a tap. */
export const DOUBLE_SHIFT_MAX_HOLD_MS = 300;

/**
 * IntelliJ-style double-Shift: two clean Shift taps within `windowMs`. A tap
 * is a Shift press+release that is short (≤ `maxHoldMs`), starts with no other
 * key held, and sees no other key or pointer press before release. So Shift as
 * a modifier (typing a capital, Shift+click range selection), a long hold, and
 * key-repeat never count. Returns a feed function that reports `true` on the
 * event that completes the gesture.
 */
export function createDoubleShiftDetector(windowMs = DOUBLE_SHIFT_WINDOW_MS, maxHoldMs = DOUBLE_SHIFT_MAX_HOLD_MS) {
  let shiftDownAt: number | null = null;
  let dirty = false; // Shift was used as a modifier during this press
  let lastTapAt: number | null = null;
  const otherKeysDown = new Set<string>();

  return function feed(event: KeyLike): boolean {
    if (event.type === 'reset') {
      shiftDownAt = null;
      dirty = false;
      lastTapAt = null;
      otherKeysDown.clear();
      return false;
    }

    if (event.type === 'pointerdown') {
      if (shiftDownAt !== null) dirty = true;
      lastTapAt = null;
      return false;
    }

    if (event.key !== 'Shift') {
      if (event.type === 'keydown') {
        otherKeysDown.add(event.key.toLowerCase());
        dirty = true;
        lastTapAt = null;
      } else if (/^meta/i.test(event.key)) {
        // macOS swallows keyups of keys pressed while Cmd was held, so a
        // Cmd release is the only reliable "those are up now" signal.
        otherKeysDown.clear();
      } else {
        otherKeysDown.delete(event.key.toLowerCase());
      }
      return false;
    }

    if (event.type === 'keydown') {
      if (event.repeat) return false;
      shiftDownAt = event.timeStamp;
      // Another key still held (e.g. `a↓ Shift↓ a↑ Shift↑`) makes this a chord.
      dirty = otherKeysDown.size > 0;
      return false;
    }

    // keyup Shift
    if (shiftDownAt === null) return false;
    const heldFor = event.timeStamp - shiftDownAt;
    shiftDownAt = null;
    if (dirty || heldFor > maxHoldMs) {
      lastTapAt = null;
      return false;
    }
    if (lastTapAt !== null && event.timeStamp - lastTapAt <= windowMs) {
      lastTapAt = null;
      return true;
    }
    lastTapAt = event.timeStamp;
    return false;
  };
}

type ElementLike = {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
};

/**
 * Surfaces where a stray double-Shift must not hijack focus: text inputs, the
 * chat composer, the xterm shell, and the CodeMirror editor.
 */
const TYPING_SURFACE_SELECTOR = '.xterm, .cm-editor, [contenteditable="true"], [data-search-everywhere-ignore]';

export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as ElementLike;
  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  if (typeof el.closest === 'function' && el.closest(TYPING_SURFACE_SELECTOR)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Interim filtering (replaced by the fuzzy matcher from #21)
// ---------------------------------------------------------------------------

/** Every whitespace-separated term must appear (case-insensitive) in one of the fields. */
export function matchesAllTerms(query: string, ...fields: Array<string | null | undefined>): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = fields.filter(Boolean).join('\n').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Cheap relevance for the interim filter: exact > prefix > word-start >
 * substring on the primary label; ties keep input order (stable sort).
 */
export function scoreLabel(query: string, label: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const l = label.toLowerCase();
  if (l === q) return 4;
  if (l.startsWith(q)) return 3;
  if (new RegExp(`(^|[\\s/._-])${escapeRegExp(q)}`).test(l)) return 2;
  if (l.includes(q)) return 1;
  return 0;
}

export function filterAndRank<T>(
  items: readonly T[],
  query: string,
  getLabel: (item: T) => string,
  getExtra: (item: T) => Array<string | null | undefined> = () => [],
): T[] {
  if (!query.trim()) return [...items];
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => matchesAllTerms(query, getLabel(item), ...getExtra(item)))
    .map((entry) => ({ ...entry, score: scoreLabel(query, getLabel(entry.item)) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Opening a message hit
// ---------------------------------------------------------------------------

export type MessageHit = {
  projectId: string | null;
  projectName: string;
  sessionId: string;
  provider: string;
  sessionSummary: string;
  isArchived: boolean;
  snippet: string;
  highlights: Array<{ start: number; end: number }>;
  role: string;
  timestamp: string | null;
  messageUuid: string | null;
};

type SessionLike = { id: string; summary?: string; [key: string]: unknown };
type ProjectLike = { projectId: string; sessions?: SessionLike[] };

/**
 * The session payload that makes ChatInterface scroll to and highlight the
 * matched message (useChatSessionState reads the `__searchTarget*` fields and
 * drives inChatHighlight). Mirrors the sidebar's `openSearchResultSession` so
 * both surfaces land identically.
 */
export function buildMessageHitSelection<P extends ProjectLike>(
  hit: MessageHit,
  projects: readonly P[],
  query: string,
): { project: P | null; session: Record<string, unknown> & { id: string } } {
  const project = hit.projectId
    ? projects.find((candidate) => candidate.projectId === hit.projectId) ?? null
    : null;
  const loaded = project?.sessions?.find((candidate) => candidate.id === hit.sessionId);

  return {
    project,
    session: {
      ...loaded,
      id: hit.sessionId,
      summary: loaded?.summary || hit.sessionSummary,
      __provider: hit.provider || 'claude',
      __projectId: project?.projectId ?? hit.projectId ?? undefined,
      __searchTargetTimestamp: hit.timestamp || null,
      __searchTargetSnippet: hit.snippet || null,
      __searchTargetUuid: hit.messageUuid || null,
      __searchQuery: query || null,
      __isArchived: Boolean(hit.isArchived),
    },
  };
}

/** Split a snippet into plain/highlighted runs from server-provided offsets. */
export function splitHighlights(
  text: string,
  highlights: ReadonlyArray<{ start: number; end: number }>,
): Array<{ text: string; match: boolean }> {
  const ranges = [...highlights]
    .filter((h) => h.end > h.start && h.start < text.length)
    .sort((a, b) => a.start - b.start);
  const out: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  for (const { start, end } of ranges) {
    const s = Math.max(start, cursor);
    const e = Math.min(end, text.length);
    if (e <= s) continue;
    if (s > cursor) out.push({ text: text.slice(cursor, s), match: false });
    out.push({ text: text.slice(s, e), match: true });
    cursor = e;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), match: false });
  return out;
}
