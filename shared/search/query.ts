/**
 * Shared search-query model + inline filter parser.
 *
 * Every search surface (sidebar, Cmd+K palette, Search Everywhere dialog) and
 * the server speak this one structure. UI toggles and inline tokens typed into
 * the search box map onto the same {@link SearchQuery}; chips are rendered from
 * {@link tokenizeSearchQuery}.
 *
 * Pure module: no imports, no I/O, no clock reads (date tokens are kept as
 * typed and resolved by {@link resolveSearchDate} with an explicit `now`).
 *
 * ## Grammar
 *
 * ```
 * query   := segment (WS+ segment)*
 * segment := filter | text
 * filter  := ['-'] key ':' value
 * value   := bare | '"' (char | '\"' | '\\')* '"'
 * bare    := non-whitespace chars (a `"` inside starts a quoted run)
 * ```
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
 * | `after:2026-10-01` `before:…` | date bound; also `today`, `yesterday`, `7d`, `2w`, `3m`, `1y` | — (text)        |
 * | `is:archived`                 | archived sessions only                         | exclude archived (default)     |
 * | `archived:include\|only\|exclude` | archived handling, explicit               | — (text)                       |
 * | `is:running` / `is:favorite`  | only running / favorite sessions               | clears the flag                |
 * | `match:case\|word\|regex`     | match case / whole words / regular expression  | turns the option off           |
 * | `scope:<preset or name>`      | scope preset or named scope                    | — (text)                       |
 *
 * Anything else — unknown keys (`http://x`, `C:\dir`), invalid values
 * (`in:nowhere`, `after:soon`), empty values (`project:`), bare negations
 * (`rm -rf`) — falls through as free text, verbatim. To search for text that
 * looks like a filter, quote the whole segment (`"in:title"` is text). Repeated single-valued
 * tokens: last one wins. List values are de-duplicated (first occurrence kept).
 *
 * Free text is the non-filter segments joined by one space (runs of whitespace
 * between segments collapse; whitespace inside a quoted segment is preserved).
 *
 * `formatSearchQuery` emits text first, then filters in a canonical order, and
 * only emits non-default fields, so `parse(format(parse(s)))` deep-equals
 * `parse(s)`. Limitation: free text that itself looks like a valid filter
 * token (only constructible programmatically, never via parse) would re-parse
 * as a filter.
 */

export const SEARCH_ROLES = ['user', 'assistant', 'tool'] as const;
export type SearchRole = (typeof SEARCH_ROLES)[number];

export const SEARCH_PROVIDERS = ['claude', 'codex', 'gemini', 'cursor'] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

export const SEARCH_IN_VALUES = ['both', 'title', 'content'] as const;
export type SearchIn = (typeof SEARCH_IN_VALUES)[number];

export const SEARCH_ARCHIVED_VALUES = ['exclude', 'include', 'only'] as const;
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
  /** Raw date token (`2026-10-01`, ISO datetime, `today`, `7d`…); see {@link resolveSearchDate}. */
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
    archived: 'exclude',
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

const KEY_PATTERN = /^(-?)([A-Za-z]+):/;

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

/** Splits input into whitespace-separated segments, keeping quoted runs intact. */
function splitSegments(input: string): Array<{ raw: string; start: number; end: number }> {
  const segments: Array<{ raw: string; start: number; end: number }> = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && isWhitespace(input[i])) i++;
    if (i >= input.length) break;
    const start = i;
    let inQuote = false;
    while (i < input.length) {
      const ch = input[i];
      if (inQuote) {
        if (ch === '\\' && i + 1 < input.length) {
          i += 2;
          continue;
        }
        if (ch === '"') inQuote = false;
        i++;
        continue;
      }
      if (isWhitespace(ch)) break;
      if (ch === '"') inQuote = true;
      i++;
    }
    segments.push({ raw: input.slice(start, i), start, end: i });
  }
  return segments;
}

/**
 * Decodes a filter value. A value that is exactly one quoted run is unquoted
 * and unescaped; an unterminated quote is invalid (returns null, so the
 * segment falls through as text). Bare values are returned as-is.
 */
function decodeValue(rawValue: string): string | null {
  if (!rawValue.startsWith('"')) {
    return rawValue.includes('"') ? null : rawValue;
  }
  let out = '';
  let i = 1;
  while (i < rawValue.length) {
    const ch = rawValue[i];
    if (ch === '\\' && i + 1 < rawValue.length) {
      out += rawValue[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') {
      // Closing quote must end the segment.
      return i === rawValue.length - 1 ? out : null;
    }
    out += ch;
    i++;
  }
  return null; // unterminated
}

/**
 * Tokenizes input into text and filter segments with source offsets (for
 * chips / input highlighting). A segment is a filter only if its key is known,
 * its value is valid for that key, and negation is allowed for that key.
 */
export function tokenizeSearchQuery(input: string): SearchToken[] {
  return splitSegments(input ?? '').map((segment): SearchToken => {
    const asText: SearchToken = { kind: 'text', ...segment };
    const match = KEY_PATTERN.exec(segment.raw);
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const RELATIVE_DATE = /^(\d+)([dwmy])$/i;

function isValidDateToken(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower === 'today' || lower === 'yesterday') return true;
  if (RELATIVE_DATE.test(value)) return true;
  if (!ISO_DATE.test(value)) return false;
  return !Number.isNaN(Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value));
}

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
  const query = createSearchQuery();
  const textParts: string[] = [];
  for (const token of tokenizeSearchQuery(input)) {
    if (token.kind === 'text') textParts.push(token.raw);
    else applyFilter(query, token);
  }
  query.text = textParts.join(' ');
  return query;
}

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

/** Quotes a filter value when it would not survive as a bare token. */
export function formatFilterValue(value: string): string {
  if (value.length > 0 && !/[\s"\\]/.test(value)) return value;
  return `"${value.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
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
  else if (query.archived === 'include') add('archived', 'include');
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
  return [query.text.trim(), ...formatFilters(query)].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Resolves a date token to an ISO-8601 instant. Date-only and relative values
 * resolve to UTC midnight at the start of that day (so `after:today` means
 * "since 00:00 UTC today"; `before:2026-10-01` means "before Oct 1"). Returns
 * null for invalid input.
 */
export function resolveSearchDate(value: string | null, now: Date): string | null {
  if (!value || !isValidDateToken(value)) return null;
  const lower = value.toLowerCase();
  const startOfDay = (d: Date) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

  if (lower === 'today') return startOfDay(now).toISOString();
  if (lower === 'yesterday') {
    const d = startOfDay(now);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString();
  }
  const rel = RELATIVE_DATE.exec(value);
  if (rel) {
    const amount = Number(rel[1]);
    const d = startOfDay(now);
    const unit = rel[2].toLowerCase();
    if (unit === 'd') d.setUTCDate(d.getUTCDate() - amount);
    else if (unit === 'w') d.setUTCDate(d.getUTCDate() - amount * 7);
    else if (unit === 'm') d.setUTCMonth(d.getUTCMonth() - amount);
    else d.setUTCFullYear(d.getUTCFullYear() - amount);
    return d.toISOString();
  }
  return new Date(value.length === 10 ? `${value}T00:00:00Z` : value).toISOString();
}
