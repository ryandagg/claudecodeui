import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createSearchQuery,
  formatFilterValue,
  formatSearchQuery,
  hasSearchFilters,
  isValidTimeZone,
  normalizeSearchQuery,
  parseSearchQuery,
  resolveSearchDate,
  tokenizeSearchQuery,
  type SearchQuery,
} from '../query.js';

const q = (overrides: Partial<SearchQuery> = {}) => createSearchQuery(overrides);

describe('parseSearchQuery — empty / whitespace', () => {
  it('empty string yields the default query', () => {
    assert.deepEqual(parseSearchQuery(''), q());
  });

  it('whitespace-only yields the default query', () => {
    assert.deepEqual(parseSearchQuery('  \t\n  '), q());
  });

  it('tolerates null/undefined input', () => {
    assert.deepEqual(parseSearchQuery(undefined as unknown as string), q());
  });

  it('trims outer whitespace', () => {
    assert.equal(parseSearchQuery('  foo  ').text, 'foo');
  });

  it('keeps original whitespace between adjacent text segments', () => {
    assert.equal(parseSearchQuery('a  b\tc').text, 'a  b\tc');
  });

  it('joins text around a removed filter with one space', () => {
    assert.equal(parseSearchQuery('a   in:title   b').text, 'a b');
  });

  it('plain text is untouched', () => {
    assert.deepEqual(parseSearchQuery('hello world'), q({ text: 'hello world' }));
  });

  it('unicode text and values', () => {
    const parsed = parseSearchQuery('café 日本語 project:プロジェクト');
    assert.equal(parsed.text, 'café 日本語');
    assert.deepEqual(parsed.projects.include, ['プロジェクト']);
  });
});

describe('parseSearchQuery — filters', () => {
  it('extracts filters anywhere in the input and keeps remaining text in order', () => {
    const parsed = parseSearchQuery('fix project:dashboard the in:title bug');
    assert.equal(parsed.text, 'fix the bug');
    assert.deepEqual(parsed.projects, { include: ['dashboard'], exclude: [] });
    assert.equal(parsed.in, 'title');
  });

  it('negated project/path go to exclude', () => {
    const parsed = parseSearchQuery('-project:signup path:~/repos/* -path:~/repos/worktrees/**');
    assert.deepEqual(parsed.projects, { include: [], exclude: ['signup'] });
    assert.deepEqual(parsed.paths, { include: ['~/repos/*'], exclude: ['~/repos/worktrees/**'] });
    assert.equal(parsed.text, '');
  });

  it('keys are case-insensitive, values keep case', () => {
    const parsed = parseSearchQuery('Project:MyApp IN:Title Role:USER');
    assert.deepEqual(parsed.projects.include, ['MyApp']);
    assert.equal(parsed.in, 'title');
    assert.deepEqual(parsed.roles, ['user']);
  });

  it('repeatable lists accumulate and de-duplicate', () => {
    const parsed = parseSearchQuery('role:user role:tool role:user provider:codex provider:claude provider:codex');
    assert.deepEqual(parsed.roles, ['user', 'tool']);
    assert.deepEqual(parsed.providers, ['codex', 'claude']);
  });

  it('project include and exclude can both hold the same value (exclude wins downstream)', () => {
    assert.deepEqual(parseSearchQuery('project:a -project:a').projects, { include: ['a'], exclude: ['a'] });
  });

  it('single-valued keys: last one wins', () => {
    const parsed = parseSearchQuery('in:title in:content after:2026-01-01 after:2026-02-01 scope:a scope:b');
    assert.equal(parsed.in, 'content');
    assert.equal(parsed.after, '2026-02-01');
    assert.equal(parsed.scope, 'b');
  });

  it('is: flags and archived modes', () => {
    assert.equal(parseSearchQuery('').archived, 'auto');
    assert.equal(parseSearchQuery('is:archived').archived, 'only');
    assert.equal(parseSearchQuery('-is:archived').archived, 'exclude');
    assert.equal(parseSearchQuery('archived:include').archived, 'include');
    assert.equal(parseSearchQuery('archived:exclude').archived, 'exclude');
    assert.equal(parseSearchQuery('is:archived archived:auto').archived, 'auto');
    assert.equal(parseSearchQuery('is:running').running, true);
    assert.equal(parseSearchQuery('is:favorite').favorite, true);
    assert.equal(parseSearchQuery('is:favorite -is:favorite').favorite, false);
  });

  it('match: options', () => {
    const parsed = parseSearchQuery('match:case match:word match:regex foo');
    assert.equal(parsed.matchCase, true);
    assert.equal(parsed.wholeWord, true);
    assert.equal(parsed.regex, true);
    assert.equal(parseSearchQuery('match:regex -match:regex').regex, false);
  });

  it('date tokens: absolute, zoneless, relative', () => {
    assert.equal(parseSearchQuery('after:2026-10-01').after, '2026-10-01');
    assert.equal(parseSearchQuery('before:7d').before, '7d');
    assert.equal(parseSearchQuery('after:2026-10-01T12:30:00Z').after, '2026-10-01T12:30:00Z');
    assert.equal(parseSearchQuery('after:2026-10-01T12:30').after, '2026-10-01T12:30');
    assert.equal(parseSearchQuery('after:2026-10-01T12:30+05:30').after, '2026-10-01T12:30+05:30');
    assert.equal(parseSearchQuery('after:today').after, 'today');
    assert.equal(parseSearchQuery('before:Yesterday').before, 'Yesterday');
    assert.equal(parseSearchQuery('after:2024-02-29').after, '2024-02-29');
  });

  it('scope accepts presets and arbitrary named scopes', () => {
    assert.equal(parseSearchQuery('scope:all-projects').scope, 'all-projects');
    assert.equal(parseSearchQuery('scope:"Work repos"').scope, 'Work repos');
  });

  it('value containing colons is fine', () => {
    assert.deepEqual(parseSearchQuery('path:C:/repos/*').paths.include, ['C:/repos/*']);
  });
});

describe('parseSearchQuery — quoting', () => {
  it('quoted values may contain spaces', () => {
    const parsed = parseSearchQuery('project:"my app" hello');
    assert.deepEqual(parsed.projects.include, ['my app']);
    assert.equal(parsed.text, 'hello');
  });

  it('\\" and \\\\ are escapes inside quoted values', () => {
    assert.deepEqual(parseSearchQuery('project:"say \\"hi\\" a\\\\b"').projects.include, ['say "hi" a\\b']);
  });

  it('other backslashes inside quoted values are literal (Windows paths)', () => {
    assert.deepEqual(parseSearchQuery('path:"C:\\Users\\me x"').paths.include, ['C:\\Users\\me x']);
    assert.deepEqual(parseSearchQuery('path:C:\\Users').paths.include, ['C:\\Users']);
  });

  it('negated quoted value', () => {
    assert.deepEqual(parseSearchQuery('-path:"~/My Repos/*"').paths.exclude, ['~/My Repos/*']);
  });

  it('a stray quote mid-segment is literal and does not swallow later filters', () => {
    const parsed = parseSearchQuery('6" pipe in:title');
    assert.equal(parsed.text, '6" pipe');
    assert.equal(parsed.in, 'title');
  });

  it('an unterminated quote at segment start is literal; later filters still parse', () => {
    const parsed = parseSearchQuery('project:y foo "bar in:title');
    assert.deepEqual(parsed.projects.include, ['y']);
    assert.equal(parsed.text, 'foo "bar');
    assert.equal(parsed.in, 'title');
  });

  it('an unterminated quoted value is text', () => {
    const parsed = parseSearchQuery('project:"my app foo');
    assert.deepEqual(parsed.projects.include, []);
    assert.equal(parsed.text, 'project:"my app foo');
  });

  it('trailing chars after a closing quote make the segment text', () => {
    const parsed = parseSearchQuery('project:"a"b');
    assert.deepEqual(parsed.projects.include, []);
    assert.equal(parsed.text, 'project:"a"b');
  });

  it('a mid-value quote is literal', () => {
    assert.deepEqual(parseSearchQuery('project:a"b').projects.include, ['a"b']);
  });

  it('quoted free text is unquoted, keeping inner whitespace', () => {
    assert.equal(parseSearchQuery('"rm   -rf" now').text, 'rm   -rf now');
  });

  it('quoting a token-like segment makes it text', () => {
    const parsed = parseSearchQuery('"in:title"');
    assert.equal(parsed.in, 'both');
    assert.equal(parsed.text, 'in:title');
  });

  it('escaped quotes in quoted text give literal quotes', () => {
    assert.equal(parseSearchQuery('"\\"id\\": 5"').text, '"id": 5');
  });

  it('regex text with token-like pieces must be quoted; backslashes survive', () => {
    const parsed = parseSearchQuery('"path:\\d+" match:regex');
    assert.equal(parsed.text, 'path:\\d+');
    assert.equal(parsed.regex, true);
    assert.deepEqual(parsed.paths.include, []);
    assert.equal(parseSearchQuery('foo\\s+bar match:regex').text, 'foo\\s+bar');
  });

  it('empty quoted value is text; empty quoted text contributes nothing', () => {
    assert.equal(parseSearchQuery('project:""').text, 'project:""');
    assert.equal(parseSearchQuery('a "" b').text, 'a b');
  });
});

describe('parseSearchQuery — fall-through to text', () => {
  const cases: Array<[string, string]> = [
    ['unknown key', 'foo:bar'],
    ['url', 'http://example.com/x'],
    ['windows path', 'C:\\Users\\me'],
    ['bare negation', 'rm -rf'],
    ['negated unknown key', '-foo:bar'],
    ['empty value', 'project:'],
    ['invalid in', 'in:nowhere'],
    ['invalid role', 'role:system'],
    ['invalid provider', 'provider:openai'],
    ['invalid date', 'after:soon'],
    ['invalid month', 'after:2026-13-01'],
    ['invalid calendar day', 'after:2026-02-30'],
    ['non-leap Feb 29', 'after:2025-02-29'],
    ['invalid time', 'after:2026-01-01T25:00'],
    ['huge relative date', 'after:300000y'],
    ['relative over cap', 'after:101y'],
    ['invalid is', 'is:pinned'],
    ['invalid match', 'match:fuzzy'],
    ['invalid archived', 'archived:maybe'],
    ['non-negatable in', '-in:title'],
    ['non-negatable role', '-role:user'],
    ['non-negatable provider', '-provider:codex'],
    ['non-negatable date', '-after:7d'],
    ['non-negatable archived', '-archived:include'],
    ['non-negatable scope', '-scope:x'],
    ['double dash', '--project:x'],
    ['key with digits', 'h2:hello'],
    ['colon only', ':'],
    ['leading colon', ':project'],
  ];
  for (const [label, input] of cases) {
    it(label, () => {
      assert.deepEqual(parseSearchQuery(input), q({ text: input }));
    });
  }

  it('mixed: invalid tokens stay text while valid ones parse', () => {
    const parsed = parseSearchQuery('in:nowhere project:x foo:bar');
    assert.equal(parsed.text, 'in:nowhere foo:bar');
    assert.deepEqual(parsed.projects.include, ['x']);
  });
});

describe('tokenizeSearchQuery', () => {
  it('returns source offsets for text and filter tokens', () => {
    const input = 'foo -project:"my app"  "a b"';
    const tokens = tokenizeSearchQuery(input);
    assert.deepEqual(tokens, [
      { kind: 'text', raw: 'foo', start: 0, end: 3, value: 'foo' },
      { kind: 'filter', raw: '-project:"my app"', start: 4, end: 21, key: 'project', value: 'my app', negated: true },
      { kind: 'text', raw: '"a b"', start: 23, end: 28, value: 'a b' },
    ]);
    for (const token of tokens) {
      assert.equal(input.slice(token.start, token.end), token.raw);
    }
  });

  it('empty input yields no tokens', () => {
    assert.deepEqual(tokenizeSearchQuery(''), []);
  });
});

describe('formatSearchQuery', () => {
  it('default query formats to empty string', () => {
    assert.equal(formatSearchQuery(q()), '');
  });

  it('text first, then filters in canonical order', () => {
    const formatted = formatSearchQuery(
      q({
        text: 'hello',
        matchCase: true,
        projects: { include: ['a'], exclude: ['b'] },
        in: 'title',
        scope: 'all-projects',
      }),
    );
    assert.equal(formatted, 'hello scope:all-projects project:a -project:b in:title match:case');
  });

  it('omits defaults (in:both, archived:auto, false flags)', () => {
    assert.equal(formatSearchQuery(q({ text: 'x', in: 'both', archived: 'auto' })), 'x');
  });

  it('emits archived modes', () => {
    assert.equal(formatSearchQuery(q({ archived: 'only' })), 'is:archived');
    assert.equal(formatSearchQuery(q({ archived: 'include' })), 'archived:include');
    assert.equal(formatSearchQuery(q({ archived: 'exclude' })), 'archived:exclude');
  });

  it('quotes filter values that need it', () => {
    assert.equal(formatFilterValue('plain'), 'plain');
    assert.equal(formatFilterValue('C:\\x'), 'C:\\x');
    assert.equal(formatFilterValue('a"b'), 'a"b');
    assert.equal(formatFilterValue('my app'), '"my app"');
    assert.equal(formatFilterValue('"lead'), '"\\"lead"');
    assert.equal(formatFilterValue('a\\b c'), '"a\\\\b c"');
    assert.equal(formatFilterValue(''), '""');
  });

  it('emits text bare when safe, quoted otherwise', () => {
    assert.equal(formatSearchQuery(q({ text: 'a  b' })), 'a  b');
    assert.equal(formatSearchQuery(q({ text: 'in:title' })), '"in:title"');
    assert.equal(formatSearchQuery(q({ text: 'path:\\d+', regex: true })), '"path:\\\\d+" match:regex');
    assert.equal(formatSearchQuery(q({ text: ' padded ' })), '" padded "');
    assert.equal(formatSearchQuery(q({ text: '6" pipe' })), '"6\\" pipe"');
  });
});

describe('round-trip', () => {
  const inputs = [
    '',
    'hello world',
    'a  b\tc',
    'project:dashboard -project:signup fix bug',
    'path:"~/My Repos/*" -path:~/repos/worktrees/** in:title',
    'path:"C:\\Users\\me x" path:C:\\Users',
    'role:user role:assistant provider:codex after:2026-10-01 before:7d',
    'after:2026-10-01T12:30 before:2026-11-01T00:00:00+05:30',
    'is:archived is:running is:favorite match:case match:word match:regex',
    '-is:archived foo',
    'archived:include scope:"Work repos" text here',
    'project:"say \\"hi\\""',
    'rm -rf in:nowhere foo:bar "quoted   phrase"',
    'project:"unterminated value',
    'project:y foo "bar in:title',
    '6" pipe in:title',
    '"in:title" project:x',
    '"path:\\d+" match:regex',
    '"\\"id\\": 5"',
    'café 日本語 project:プロジェクト',
    'project:a -project:a',
    'a "" b',
  ];
  for (const input of inputs) {
    it(`parse(format(parse(${JSON.stringify(input)}))) == parse(input)`, () => {
      const once = parseSearchQuery(input);
      const formatted = formatSearchQuery(once);
      assert.deepEqual(parseSearchQuery(formatted), once);
      assert.equal(formatSearchQuery(parseSearchQuery(formatted)), formatted);
    });
  }

  it('format(query) re-parses to the same query for a fully populated object', () => {
    const full = q({
      text: 'needle "quoted" in:title',
      scope: 'No worktrees',
      projects: { include: ['my app', 'b'], exclude: ['c'] },
      paths: { include: ['~/x/*'], exclude: ['~/x/worktrees/**'] },
      in: 'content',
      matchCase: true,
      wholeWord: true,
      regex: true,
      roles: ['tool'],
      providers: ['gemini'],
      after: '30d',
      before: '2026-11-01',
      archived: 'include',
      running: true,
      favorite: true,
    });
    assert.deepEqual(parseSearchQuery(formatSearchQuery(full)), full);
  });
});

describe('createSearchQuery / hasSearchFilters', () => {
  it('createSearchQuery copies arrays (no shared mutable defaults)', () => {
    const a = createSearchQuery();
    a.projects.include.push('x');
    a.roles.push('user');
    assert.deepEqual(createSearchQuery().projects.include, []);
    assert.deepEqual(createSearchQuery().roles, []);
  });

  it('hasSearchFilters ignores text', () => {
    assert.equal(hasSearchFilters(q({ text: 'foo' })), false);
    assert.equal(hasSearchFilters(parseSearchQuery('foo in:title')), true);
    assert.equal(hasSearchFilters(parseSearchQuery('scope:all-projects')), true);
  });
});

describe('resolveSearchDate', () => {
  const now = new Date('2026-11-05T15:30:00Z');
  const utc = { now };

  it('null / invalid → null, never throws', () => {
    assert.equal(resolveSearchDate(null, utc), null);
    assert.equal(resolveSearchDate('soon', utc), null);
    assert.equal(resolveSearchDate('300000y', utc), null);
    assert.equal(resolveSearchDate('2026-02-30', utc), null);
    assert.equal(resolveSearchDate('7d', { now: new Date(NaN) }), null);
  });

  it('absolute dates resolve to midnight in the zone (UTC default)', () => {
    assert.equal(resolveSearchDate('2026-10-01', utc), '2026-10-01T00:00:00.000Z');
    assert.equal(
      resolveSearchDate('2026-10-01', { now, timeZone: 'America/Los_Angeles' }),
      '2026-10-01T07:00:00.000Z',
    );
  });

  it('datetimes with Z or offset are absolute regardless of zone', () => {
    const opts = { now, timeZone: 'Asia/Tokyo' };
    assert.equal(resolveSearchDate('2026-10-01T12:30:00Z', opts), '2026-10-01T12:30:00.000Z');
    assert.equal(resolveSearchDate('2026-10-01T12:30+05:30', opts), '2026-10-01T07:00:00.000Z');
    assert.equal(resolveSearchDate('2026-10-01T12:30:00.5-0100', opts), '2026-10-01T13:30:00.500Z');
  });

  it('zoneless datetimes are wall-clock time in the zone (not machine-local)', () => {
    assert.equal(resolveSearchDate('2026-10-01T12:30', utc), '2026-10-01T12:30:00.000Z');
    assert.equal(
      resolveSearchDate('2026-10-01T12:30', { now, timeZone: 'Asia/Tokyo' }),
      '2026-10-01T03:30:00.000Z',
    );
  });

  it('today / yesterday use the zone’s calendar day', () => {
    assert.equal(resolveSearchDate('today', utc), '2026-11-05T00:00:00.000Z');
    assert.equal(resolveSearchDate('YESTERDAY', utc), '2026-11-04T00:00:00.000Z');
    // 15:30Z is already Nov 6 in Tokyo (+09:00).
    assert.equal(resolveSearchDate('today', { now, timeZone: 'Asia/Tokyo' }), '2026-11-05T15:00:00.000Z');
  });

  it('relative units', () => {
    assert.equal(resolveSearchDate('7d', utc), '2026-10-29T00:00:00.000Z');
    assert.equal(resolveSearchDate('2w', utc), '2026-10-22T00:00:00.000Z');
    assert.equal(resolveSearchDate('1m', utc), '2026-10-05T00:00:00.000Z');
    assert.equal(resolveSearchDate('1y', utc), '2025-11-05T00:00:00.000Z');
    assert.equal(resolveSearchDate('0d', utc), '2026-11-05T00:00:00.000Z');
    assert.equal(resolveSearchDate('100y', utc), '1926-11-05T00:00:00.000Z');
  });

  it('month/year arithmetic clamps to month end', () => {
    assert.equal(resolveSearchDate('1m', { now: new Date('2026-03-31T10:00:00Z') }), '2026-02-28T00:00:00.000Z');
    assert.equal(resolveSearchDate('1m', { now: new Date('2024-03-31T10:00:00Z') }), '2024-02-29T00:00:00.000Z');
    assert.equal(resolveSearchDate('1y', { now: new Date('2024-02-29T10:00:00Z') }), '2023-02-28T00:00:00.000Z');
    assert.equal(resolveSearchDate('13m', { now: new Date('2026-01-15T10:00:00Z') }), '2024-12-15T00:00:00.000Z');
  });

  it('DST: local midnight across a transition', () => {
    // US DST ends 2026-11-01; Nov 2 midnight in LA is PST (-08:00), Oct 31 is PDT (-07:00).
    const opts = { now: new Date('2026-11-02T20:00:00Z'), timeZone: 'America/Los_Angeles' };
    assert.equal(resolveSearchDate('today', opts), '2026-11-02T08:00:00.000Z');
    assert.equal(resolveSearchDate('2d', opts), '2026-10-31T07:00:00.000Z');
  });

  it('invalid time zone falls back to UTC', () => {
    assert.equal(isValidTimeZone('Not/AZone'), false);
    assert.equal(isValidTimeZone('Europe/Berlin'), true);
    assert.equal(resolveSearchDate('2026-10-01', { now, timeZone: 'Not/AZone' }), '2026-10-01T00:00:00.000Z');
  });
});

describe('normalizeSearchQuery', () => {
  it('garbage → defaults', () => {
    for (const input of [null, undefined, 42, 'str', [], {}]) {
      assert.deepEqual(normalizeSearchQuery(input), q());
    }
  });

  it('keeps a valid query intact', () => {
    const full = parseSearchQuery(
      'needle scope:x project:a -project:b path:~/p/* -path:~/p/w/** in:title role:user provider:codex ' +
        'after:7d before:2026-11-01 archived:include is:running is:favorite match:case match:word match:regex',
    );
    assert.deepEqual(normalizeSearchQuery(JSON.parse(JSON.stringify(full))), full);
  });

  it('drops invalid members and unknown fields', () => {
    const normalized = normalizeSearchQuery({
      text: 5,
      scope: '',
      projects: { include: ['a', 3, '', 'a'], exclude: 'nope' },
      in: 'everywhere',
      matchCase: 'yes',
      roles: ['USER', 'system', null],
      providers: ['openai', 'Claude'],
      after: '300000y',
      before: '2026-01-01',
      archived: 'sometimes',
      extra: true,
    });
    assert.deepEqual(
      normalized,
      q({ projects: { include: ['a'], exclude: [] }, roles: ['user'], providers: ['claude'], before: '2026-01-01' }),
    );
  });
});
