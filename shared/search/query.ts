/**
 * Shared search-query model + inline filter parser.
 *
 * Every search surface (sidebar, Cmd+K palette, Search Everywhere dialog) and
 * the server speak this one structure. UI toggles and inline tokens typed into
 * the search box map onto the same {@link SearchQuery}; chips are rendered from
 * {@link tokenizeSearchQuery}.
 *
 * Pure module: no imports, no I/O, no clock reads. Date tokens are kept as
 * typed and resolved by {@link resolveSearchDate} with an explicit `now` and
 * time zone (clients resolve in the user's zone and send ISO instants).
 *
 * ## Grammar
 *
 * ```
 * query   := WS* segment (WS+ segment)* WS*
 * segment := filter | text
 * filter  := ['-'] key ':' value
 * value   := quoted | bare
 * text    := quoted | bare
 * quoted  := '"' (char | '\"' | '\\')* '"'     -- must be the whole value / whole segment
 * bare    := non-whitespace chars
 * ```
 *
 * A `"` opens a quoted run **only** at the start of a segment or directly
 * after `key:` / `-key:`; anywhere else it is a literal character (`6" pipe`
 * is plain text). Inside a quoted run, `\` escapes only `"` and `\`; any other
 * backslash is literal (`path:"C:\Users\me x"` keeps its backslashes). An
 * unterminated quote is a literal `"` and the segment ends at whitespace.
 *
 * Keys are case-insensitive; values keep their case (except enum values like
 * `in:`/`role:`/`provider:`/`is:`/`match:`, which are case-insensitive).
 *
 * | Token                         | Effect                                         | Negated (`-key:`)              |
 * | ----------------------------- | ---------------------------------------------- | ------------------------------ |
 * | `project:foo`                 | include project (name or path)                 | exclude project                |
 * | `path:~/repos/worktrees/*`    | include sessions whose project path matches    | exclude matching paths         |
 * | `in:title\|content\|both`     | which fields to search                         | — (text)                       |
 * | `role:user\|assistant\|tool`  | restrict message role (repeatable)             | — (text)                       |
 * | `provider:claude\|codex\|…`   | restrict provider (repeatable)                 | — (text)                       |
 * | `after:2026-10-01` `before:…` | date bound; also datetimes, `today`, `yesterday`, `7d`, `2w`, `3m`, `1y` | — (text) |
 * | `is:archived`                 | archived items only (`archived:only`)          | `archived:exclude`             |
 * | `archived:auto\|include\|only\|exclude` | archived handling (see {@link SearchArchived}) | — (text)         |
 * | `is:running` / `is:favorite`  | only running / favorite sessions               | clears the flag                |
 * | `match:case\|word\|regex`     | match case / whole words / regular expression  | turns the option off           |
 * | `scope:<preset or name>`      | scope preset or named scope                    | — (text)                       |
 *
 * Anything else — unknown keys (`http://x`, `C:\dir`), invalid values
 * (`in:nowhere`, `after:soon`, `after:2026-02-30`), empty values (`project:`),
 * disallowed negations (`-in:title`), bare negations (`rm -rf`) — is free
 * text. Repeated single-valued tokens: last one wins. List values are
 * de-duplicated (first occurrence kept).
 *
 * ## Free text
 *
 * A quoted text segment is unquoted (`"in:title"` → `in:title`, `"a  b"` →
 * `a  b`), which is how to search for something that looks like a filter —
 * e.g. a regex `"path:\d+"`. To search for a literal quote character, escape
 * it inside quotes (`"\"id\""`) or put it mid-segment (`say"hi`). Adjacent
 * text segments keep the original whitespace between them; where a filter was
 * removed between two text segments they are joined by one space.
 *
 * ## Format
 *
 * `formatSearchQuery` emits text first, then non-default filters in canonical
 * order. Text is emitted bare when that re-parses identically, otherwise as
 * one quoted segment, so `parse(format(q))` deep-equals `q` for any query
 * produced by `parse` or `normalizeSearchQuery`.
 */

export const SEARCH_ROLES = ['user', 'assistant', 'tool'] as const;
export type SearchRole = (typeof SEARCH_ROLES)[number];

export const SEARCH_PROVIDERS = ['claude', 'codex', 'gemini', 'cursor'] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

export const SEARCH_IN_VALUES = ['both', 'title', 'content'] as const;
export type SearchIn = (typeof SEARCH_IN_VALUES)[number];

export const SEARCH_ARCHIVED_VALUES = ['auto', 'exclude', 'include', 'only'] as const;
/**
 * How archived items participate. An item is "archived" when the session is
 * archived or its whole project is.
 * - `auto` (default): archived sessions in active projects still match (flagged
 *   `isArchived` so the UI can offer restore); sessions of archived projects
 *   are hidden. This is the pre-existing conversation-search behavior.
 * - `exclude`: no archived sessions, no archived-project sessions.
 * - `include`: everything, archived projects included.
 * - `only`: only archived items (the archive view).
 */
export type SearchArchived = (typeof SEARCH_ARCHIVED_VALUES)[number];

/**
 * Built-in scope presets (#16). Any other `scope` string is the name of a
 * user-defined named scope (#15).
 */
export const SEARCH_SCOPE_PRESETS = [
  'current-project',
  'all-projects',
  'running',
  'favorites',
  'recently-viewed',
  'recently-active',
  'archived',
] as const;
export type SearchScopePreset = (typeof SEARCH_SCOPE_PRESETS)[number];

export type IncludeExclude = {
  include: string[];
  exclude: string[];
};

export type SearchQuery = {
  /** Free text to match (titles and/or message content). */
  text: string;
  /** Scope preset or named-scope name; `null` = surface default. */
  scope: SearchScopePreset | (string & {}) | null;
  /** Project names or paths. Exclude wins on overlap. */
  projects: IncludeExclude;
  /** Directory globs matched against the session's project path. Exclude wins. */
  paths: IncludeExclude;
  in: SearchIn;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Empty = all roles. */
  roles: SearchRole[];
  /** Empty = all providers. */
  providers: SearchProvider[];
  /**
   * Date bound as typed (`2026-10-01`, `2026-10-01T12:30`, ISO instant,
   * `today`, `7d`…). `after` is inclusive, `before` exclusive. Resolve with
   * {@link resolveSearchDate}.
   */
  after: string | null;
  before: string | null;
  archived: SearchArchived;
  running: boolean;
  favorite: boolean;
};

export function createSearchQuery(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return {
    text: '',
    scope: null,
    in: 'both',
    matchCase: false,
    wholeWord: false,
    regex: false,
    after: null,
    before: null,
    archived: 'auto',
    running: false,
    favorite: false,
    ...overrides,
    projects: {
      include: [...(overrides.projects?.include ?? [])],
      exclude: [...(overrides.projects?.exclude ?? [])],
    },
    paths: {
      include: [...(overrides.paths?.include ?? [])],
      exclude: [...(overrides.paths?.exclude ?? [])],
    },
    roles: [...(overrides.roles ?? [])],
    providers: [...(overrides.providers ?? [])],
  };
}

/** True when any field other than `text` differs from its default. */
export function hasSearchFilters(query: SearchQuery): boolean {
  return formatFilters(query).length > 0;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export type SearchToken =
  | {
      kind: 'text';
      /** Exact source slice. */
      raw: string;
      start: number;
      end: number;
      /** Text contributed to the query (unquoted if the segment was a quoted run). */
      value: string;
    }
  | {
      kind: 'filter';
      raw: string;
      start: number;
      end: number;
      /** Lower-cased key, e.g. `project`. */
      key: FilterKey;
      /** Unquoted / unescaped value. */
      value: string;
      negated: boolean;
    };

const FILTER_KEYS = [
  'project',
  'path',
  'in',
  'role',
  'provider',
  'after',
  'before',
  'is',
  'archived',
  'match',
  'scope',
] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

const NEGATABLE_KEYS = new Set<FilterKey>(['project', 'path', 'is', 'match']);

const KEY_PREFIX = /^(-?)([A-Za-z]+):/;

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

/**
 * Given `input[open] === '"'`, returns the index just past the matching close
 * quote, or null if the run is unterminated. `\` escapes only `"` and `\`.
 */
function scanQuoted(input: string, open: number): number | null {
  let i = open + 1;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\' && (input[i + 1] === '"' || input[i + 1] === '\\')) {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    i += 1;
  }
  return null;
}

/** Unquotes a string that is exactly one quoted run, else returns null. */
function decodeQuoted(raw: string): string | null {
  if (!raw.startsWith('"') || scanQuoted(raw, 0) !== raw.length) return null;
  return raw.slice(1, -1).replace(/\\(["\\])/g, '$1');
}

/** Splits input into whitespace-separated segments, keeping quoted runs intact. */
function splitSegments(input: string): Array<{ raw: string; start: number; end: number }> {
  const segments: Array<{ raw: string; start: number; end: number }> = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && isWhitespace(input[i])) i += 1;
    if (i >= input.length) break;
    const start = i;
    const prefix = KEY_PREFIX.exec(input.slice(start, start + 64));
    let j = start + (prefix ? prefix[0].length : 0);
    if (input[j] === '"') {
      j = scanQuoted(input, j) ?? j;
    }
    while (j < input.length && !isWhitespace(input[j])) j += 1;
    segments.push({ raw: input.slice(start, j), start, end: j });
    i = j;
  }
  return segments;
}

function decodeValue(rawValue: string): string | null {
  return rawValue.startsWith('"') ? decodeQuoted(rawValue) : rawValue;
}

/**
 * Tokenizes input into text and filter segments with source offsets (for
 * chips / input highlighting). A segment is a filter only if its key is known,
 * its value is valid for that key, and negation is allowed for that key.
 */
export function tokenizeSearchQuery(input: string): SearchToken[] {
  return splitSegments(input ?? '').map((segment): SearchToken => {
    const asText: SearchToken = { kind: 'text', ...segment, value: decodeQuoted(segment.raw) ?? segment.raw };
    const match = KEY_PREFIX.exec(segment.raw);
    if (!match) return asText;
    const negated = match[1] === '-';
    const key = match[2].toLowerCase() as FilterKey;
    if (!(FILTER_KEYS as readonly string[]).includes(key)) return asText;
    if (negated && !NEGATABLE_KEYS.has(key)) return asText;
    const value = decodeValue(segment.raw.slice(match[0].length));
    if (value === null || value.length === 0) return asText;
    if (!isValidValue(key, value, negated)) return asText;
    return { kind: 'filter', ...segment, key, value, negated };
  });
}

// ---------------------------------------------------------------------------
// Value validation
// ---------------------------------------------------------------------------

function includesLower(list: readonly string[], value: string): boolean {
  return list.includes(value.toLowerCase());
}

function isValidValue(key: FilterKey, value: string, negated: boolean): boolean {
  switch (key) {
    case 'project':
    case 'path':
    case 'scope':
      return true;
    case 'in':
      return includesLower(SEARCH_IN_VALUES, value);
    case 'role':
      return includesLower(SEARCH_ROLES, value);
    case 'provider':
      return includesLower(SEARCH_PROVIDERS, value);
    case 'after':
    case 'before':
      return isValidDateToken(value);
    case 'is':
      return ['archived', 'running', 'favorite'].includes(value.toLowerCase());
    case 'archived':
      return !negated && includesLower(SEARCH_ARCHIVED_VALUES, value);
    case 'match':
      return ['case', 'word', 'regex'].includes(value.toLowerCase());
  }
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

function pushUnique<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value);
}

function applyFilter(query: SearchQuery, token: Extract<SearchToken, { kind: 'filter' }>): void {
  const { key, value, negated } = token;
  const lower = value.toLowerCase();
  switch (key) {
    case 'project':
      pushUnique(negated ? query.projects.exclude : query.projects.include, value);
      return;
    case 'path':
      pushUnique(negated ? query.paths.exclude : query.paths.include, value);
      return;
    case 'in':
      query.in = lower as SearchIn;
      return;
    case 'role':
      pushUnique(query.roles, lower as SearchRole);
      return;
    case 'provider':
      pushUnique(query.providers, lower as SearchProvider);
      return;
    case 'after':
      query.after = value;
      return;
    case 'before':
      query.before = value;
      return;
    case 'archived':
      query.archived = lower as SearchArchived;
      return;
    case 'scope':
      query.scope = value;
      return;
    case 'is':
      if (lower === 'archived') query.archived = negated ? 'exclude' : 'only';
      else if (lower === 'running') query.running = !negated;
      else query.favorite = !negated;
      return;
    case 'match':
      if (lower === 'case') query.matchCase = !negated;
      else if (lower === 'word') query.wholeWord = !negated;
      else query.regex = !negated;
      return;
  }
}

/** Parses a raw search-box string into a {@link SearchQuery}. Never throws. */
export function parseSearchQuery(input: string): SearchQuery {
  const source = input ?? '';
  const query = createSearchQuery();
  let text = '';
  // End offset of the previous token when it contributed text; null after a
  // filter (or an empty `""`), so the next text joins with a single space.
  let lastTextEnd: number | null = null;
  for (const token of tokenizeSearchQuery(source)) {
    if (token.kind === 'filter') {
      applyFilter(query, token);
      lastTextEnd = null;
      continue;
    }
    if (token.value.length === 0) {
      lastTextEnd = null;
      continue;
    }
    if (text.length > 0) {
      text += lastTextEnd !== null ? source.slice(lastTextEnd, token.start) : ' ';
    }
    text += token.value;
    lastTextEnd = token.end;
  }
  query.text = text;
  return query;
}

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
}

/** Quotes a filter value when it would not survive as a bare token. */
export function formatFilterValue(value: string): string {
  return value.length > 0 && !value.startsWith('"') && !/\s/.test(value) ? value : quote(value);
}

/**
 * Text is emitted bare only when it contains no quote characters and parses
 * back to exactly itself with no filters; otherwise as one quoted segment.
 */
function formatText(text: string): string {
  if (text.length === 0) return '';
  if (!text.includes('"')) {
    const reparsed = parseSearchQuery(text);
    if (reparsed.text === text && !hasSearchFilters(reparsed)) return text;
  }
  return quote(text);
}

function formatFilters(query: SearchQuery): string[] {
  const out: string[] = [];
  const add = (key: string, value: string, negated = false) =>
    out.push(`${negated ? '-' : ''}${key}:${formatFilterValue(value)}`);

  if (query.scope) add('scope', query.scope);
  for (const p of query.projects.include) add('project', p);
  for (const p of query.projects.exclude) add('project', p, true);
  for (const p of query.paths.include) add('path', p);
  for (const p of query.paths.exclude) add('path', p, true);
  if (query.in !== 'both') add('in', query.in);
  for (const r of query.roles) add('role', r);
  for (const p of query.providers) add('provider', p);
  if (query.after) add('after', query.after);
  if (query.before) add('before', query.before);
  if (query.archived === 'only') add('is', 'archived');
  else if (query.archived !== 'auto') add('archived', query.archived);
  if (query.running) add('is', 'running');
  if (query.favorite) add('is', 'favorite');
  if (query.matchCase) add('match', 'case');
  if (query.wholeWord) add('match', 'word');
  if (query.regex) add('match', 'regex');
  return out;
}

/**
 * Serializes a {@link SearchQuery} back to search-box text: free text first,
 * then non-default filters in canonical order.
 */
export function formatSearchQuery(query: SearchQuery): string {
  return [formatText(query.text), ...formatFilters(query)].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

type CalendarDate = { y: number; m: number; d: number };

type DateToken =
  | { kind: 'today' | 'yesterday' }
  | { kind: 'relative'; amount: number; unit: 'd' | 'w' | 'm' | 'y' }
  | { kind: 'local'; date: CalendarDate; h: number; min: number; s: number; ms: number }
  | { kind: 'instant'; epochMs: number };

const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/i;
const RELATIVE_DATE = /^(\d{1,5})([dwmy])$/i;
/** Upper bounds keep relative dates within ~100 years (and Date's range). */
const MAX_RELATIVE: Record<'d' | 'w' | 'm' | 'y', number> = { d: 36600, w: 5300, m: 1200, y: 100 };

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function parseDateToken(value: string): DateToken | null {
  const lower = value.toLowerCase();
  if (lower === 'today' || lower === 'yesterday') return { kind: lower };

  const rel = RELATIVE_DATE.exec(value);
  if (rel) {
    const unit = rel[2].toLowerCase() as 'd' | 'w' | 'm' | 'y';
    const amount = Number(rel[1]);
    return amount <= MAX_RELATIVE[unit] ? { kind: 'relative', amount, unit } : null;
  }

  const iso = ISO_DATE.exec(value);
  if (!iso) return null;
  const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  const h = Number(iso[4] ?? 0);
  const min = Number(iso[5] ?? 0);
  const s = Number(iso[6] ?? 0);
  const ms = Number((iso[7] ?? '0').slice(0, 3).padEnd(3, '0'));
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m) || h > 23 || min > 59 || s > 59) {
    return null;
  }

  const zone = iso[8];
  if (!zone) return { kind: 'local', date: { y, m, d }, h, min, s, ms };

  let offsetMinutes = 0;
  if (zone.toUpperCase() !== 'Z') {
    const digits = zone.replace(':', '');
    const oh = Number(digits.slice(1, 3));
    const om = Number(digits.slice(3, 5));
    if (oh > 23 || om > 59) return null;
    offsetMinutes = (digits[0] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  const epochMs = utcMs({ y, m, d }, h, min, s, ms) - offsetMinutes * 60_000;
  return { kind: 'instant', epochMs };
}

function isValidDateToken(value: string): boolean {
  return parseDateToken(value) !== null;
}

function utcMs(date: CalendarDate, h = 0, min = 0, s = 0, ms = 0): number {
  // Date.UTC maps years 0–99 to 1900+; setUTCFullYear avoids that.
  const t = new Date(Date.UTC(2000, date.m - 1, date.d, h, min, s, ms));
  t.setUTCFullYear(date.y);
  return t.getTime();
}

/** True when `timeZone` is an IANA zone this runtime understands. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedParts(epochMs: number, timeZone: string): CalendarDate & { h: number; min: number; s: number } {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatterCache.set(timeZone, formatter);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(epochMs))) parts[part.type] = part.value;
  const year = Number(parts.year);
  return {
    y: parts.era === 'BC' || parts.era === 'B' ? 1 - year : year,
    m: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    min: Number(parts.minute),
    s: Number(parts.second),
  };
}

/** Offset of `timeZone` from UTC at an instant, in ms (positive east of UTC). */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const wholeSecond = Math.floor(epochMs / 1000) * 1000;
  const p = zonedParts(wholeSecond, timeZone);
  return utcMs(p, p.h, p.min, p.s) - wholeSecond;
}

/** Instant at which the wall-clock time occurs in `timeZone` (DST-aware). */
function zonedToEpochMs(date: CalendarDate, h: number, min: number, s: number, ms: number, timeZone: string): number {
  const wall = utcMs(date, h, min, s, ms);
  if (timeZone === 'UTC') return wall;
  let t = wall - zoneOffsetMs(wall, timeZone);
  const second = zoneOffsetMs(t, timeZone);
  t = wall - second;
  return t;
}

function shiftCalendar(date: CalendarDate, amount: number, unit: 'd' | 'w' | 'm' | 'y'): CalendarDate {
  if (unit === 'd' || unit === 'w') {
    const t = new Date(utcMs(date));
    t.setUTCDate(t.getUTCDate() - amount * (unit === 'w' ? 7 : 1));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  // Month/year arithmetic clamps to the end of the target month (Mar 31 − 1m = Feb 28/29).
  const months = date.y * 12 + (date.m - 1) - amount * (unit === 'y' ? 12 : 1);
  const y = Math.floor(months / 12);
  const m = (months % 12) + 1;
  return { y, m, d: Math.min(date.d, daysInMonth(y, m)) };
}

export type ResolveSearchDateOptions = {
  now: Date;
  /** IANA zone for date-only, zoneless and relative values. Default `UTC`; invalid zones fall back to `UTC`. */
  timeZone?: string;
};

/**
 * Resolves a date token to an ISO-8601 instant, or null for invalid input.
 * Never throws.
 * - Date-only, `today`, `yesterday`, and relative values (`7d`, `2w`, `3m`,
 *   `1y`) resolve to local midnight in `timeZone` at the start of that day.
 * - Zoneless datetimes (`2026-10-01T12:30`) are wall-clock time in `timeZone`.
 * - Datetimes with `Z` or an offset are absolute.
 */
export function resolveSearchDate(value: string | null, options: ResolveSearchDateOptions): string | null {
  if (!value) return null;
  const token = parseDateToken(value);
  if (!token) return null;
  const timeZone = options.timeZone && isValidTimeZone(options.timeZone) ? options.timeZone : 'UTC';
  const nowMs = options.now.getTime();
  if (!Number.isFinite(nowMs)) return null;

  let epochMs: number;
  if (token.kind === 'instant') {
    epochMs = token.epochMs;
  } else if (token.kind === 'local') {
    epochMs = zonedToEpochMs(token.date, token.h, token.min, token.s, token.ms, timeZone);
  } else {
    const today = zonedParts(nowMs, timeZone);
    let day: CalendarDate = today;
    if (token.kind === 'relative') day = shiftCalendar(today, token.amount, token.unit);
    else if (token.kind === 'yesterday') day = shiftCalendar(today, 1, 'd');
    epochMs = zonedToEpochMs(day, 0, 0, 0, 0, timeZone);
  }

  const result = new Date(epochMs);
  return Number.isFinite(result.getTime()) ? result.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Validation (untrusted input, e.g. a JSON-encoded query from a request)
// ---------------------------------------------------------------------------

function stringList(value: unknown, allowed?: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const v = allowed ? item.toLowerCase() : item;
    if (v.length === 0 || (allowed && !allowed.includes(v))) continue;
    pushUnique(out, v);
  }
  return out;
}

function includeExclude(value: unknown): IncludeExclude {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return { include: stringList(v.include), exclude: stringList(v.exclude) };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Coerces untrusted input into a well-formed {@link SearchQuery}: unknown
 * fields are dropped, invalid values fall back to defaults. Never throws.
 */
export function normalizeSearchQuery(input: unknown): SearchQuery {
  const v = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const defaults = createSearchQuery();
  const date = (d: unknown) => (typeof d === 'string' && isValidDateToken(d) ? d : null);
  return {
    text: typeof v.text === 'string' ? v.text : '',
    scope: typeof v.scope === 'string' && v.scope.length > 0 ? v.scope : null,
    projects: includeExclude(v.projects),
    paths: includeExclude(v.paths),
    in: oneOf(v.in, SEARCH_IN_VALUES, defaults.in),
    matchCase: v.matchCase === true,
    wholeWord: v.wholeWord === true,
    regex: v.regex === true,
    roles: stringList(v.roles, SEARCH_ROLES) as SearchRole[],
    providers: stringList(v.providers, SEARCH_PROVIDERS) as SearchProvider[],
    after: date(v.after),
    before: date(v.before),
    archived: oneOf(v.archived, SEARCH_ARCHIVED_VALUES, defaults.archived),
    running: v.running === true,
    favorite: v.favorite === true,
  };
}
