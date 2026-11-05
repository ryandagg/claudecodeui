import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createSearchQuery,
  formatFilterValue,
  formatSearchQuery,
  hasSearchFilters,
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

  it('collapses whitespace between text segments and trims', () => {
    assert.equal(parseSearchQuery('  foo   bar\tbaz  ').text, 'foo bar baz');
  });

  it('plain text is untouched', () => {
    assert.deepEqual(parseSearchQuery('hello world'), q({ text: 'hello world' }));
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
    const parsed = parseSearchQuery('project:a -project:a');
    assert.deepEqual(parsed.projects, { include: ['a'], exclude: ['a'] });
  });

  it('single-valued keys: last one wins', () => {
    const parsed = parseSearchQuery('in:title in:content after:2026-01-01 after:2026-02-01 scope:a scope:b');
    assert.equal(parsed.in, 'content');
    assert.equal(parsed.after, '2026-02-01');
    assert.equal(parsed.scope, 'b');
  });

  it('is: flags', () => {
    assert.equal(parseSearchQuery('is:archived').archived, 'only');
    assert.equal(parseSearchQuery('is:archived -is:archived').archived, 'exclude');
    assert.equal(parseSearchQuery('archived:include').archived, 'include');
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

  it('date tokens: absolute and relative', () => {
    const parsed = parseSearchQuery('after:2026-10-01 before:7d');
    assert.equal(parsed.after, '2026-10-01');
    assert.equal(parsed.before, '7d');
    assert.equal(parseSearchQuery('after:2026-10-01T12:30:00Z').after, '2026-10-01T12:30:00Z');
    assert.equal(parseSearchQuery('after:today').after, 'today');
    assert.equal(parseSearchQuery('before:Yesterday').before, 'Yesterday');
  });

  it('scope accepts presets and arbitrary named scopes', () => {
    assert.equal(parseSearchQuery('scope:all-projects').scope, 'all-projects');
    assert.equal(parseSearchQuery('scope:"Work repos"').scope, 'Work repos');
  });
});

describe('parseSearchQuery — quoting', () => {
  it('quoted values may contain spaces', () => {
    const parsed = parseSearchQuery('project:"my app" hello');
    assert.deepEqual(parsed.projects.include, ['my app']);
    assert.equal(parsed.text, 'hello');
  });

  it('escaped quotes and backslashes inside quoted values', () => {
    const parsed = parseSearchQuery('project:"say \\"hi\\" C:\\\\x"');
    assert.deepEqual(parsed.projects.include, ['say "hi" C:\\x']);
  });

  it('negated quoted value', () => {
    assert.deepEqual(parseSearchQuery('-path:"~/My Repos/*"').paths.exclude, ['~/My Repos/*']);
  });

  it('unterminated quoted value falls through as text (rest of input)', () => {
    const parsed = parseSearchQuery('project:"my app foo');
    assert.deepEqual(parsed.projects.include, []);
    assert.equal(parsed.text, 'project:"my app foo');
  });

  it('trailing chars after a closing quote make the segment text', () => {
    const parsed = parseSearchQuery('project:"a"b');
    assert.deepEqual(parsed.projects.include, []);
    assert.equal(parsed.text, 'project:"a"b');
  });

  it('a bare value containing a quote is text', () => {
    assert.equal(parseSearchQuery('project:a"b').text, 'project:a"b');
  });

  it('quoted free text is kept verbatim, including inner whitespace', () => {
    assert.equal(parseSearchQuery('"rm   -rf" now').text, '"rm   -rf" now');
  });

  it('quoting a whole token escapes it as text', () => {
    const parsed = parseSearchQuery('"in:title"');
    assert.equal(parsed.in, 'both');
    assert.equal(parsed.text, '"in:title"');
  });

  it('empty quoted value is text', () => {
    assert.equal(parseSearchQuery('project:""').text, 'project:""');
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
    ['invalid calendar date', 'after:2026-13-45'],
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

  it('value containing colons is fine', () => {
    assert.deepEqual(parseSearchQuery('path:C:/repos/*').paths.include, ['C:/repos/*']);
  });
});

describe('tokenizeSearchQuery', () => {
  it('returns source offsets for text and filter tokens', () => {
    const input = 'foo -project:"my app"  bar';
    const tokens = tokenizeSearchQuery(input);
    assert.deepEqual(tokens, [
      { kind: 'text', raw: 'foo', start: 0, end: 3 },
      { kind: 'filter', raw: '-project:"my app"', start: 4, end: 21, key: 'project', value: 'my app', negated: true },
      { kind: 'text', raw: 'bar', start: 23, end: 26 },
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

  it('omits defaults (in:both, archived:exclude, false flags)', () => {
    assert.equal(formatSearchQuery(q({ text: 'x', in: 'both', archived: 'exclude' })), 'x');
  });

  it('emits archived modes', () => {
    assert.equal(formatSearchQuery(q({ archived: 'only' })), 'is:archived');
    assert.equal(formatSearchQuery(q({ archived: 'include' })), 'archived:include');
  });

  it('quotes values that need it', () => {
    assert.equal(formatFilterValue('plain'), 'plain');
    assert.equal(formatFilterValue('my app'), '"my app"');
    assert.equal(formatFilterValue('a"b'), '"a\\"b"');
    assert.equal(formatFilterValue('a\\b'), '"a\\\\b"');
    assert.equal(formatFilterValue(''), '""');
  });
});

describe('round-trip', () => {
  const inputs = [
    '',
    'hello world',
    'project:dashboard -project:signup fix bug',
    'path:"~/My Repos/*" -path:~/repos/worktrees/** in:title',
    'role:user role:assistant provider:codex after:2026-10-01 before:7d',
    'is:archived is:running is:favorite match:case match:word match:regex',
    'archived:include scope:"Work repos" text here',
    'project:"say \\"hi\\""',
    'rm -rf in:nowhere foo:bar "quoted   phrase"',
    'project:"unterminated value',
    'project:a -project:a',
  ];
  for (const input of inputs) {
    it(`parse(format(parse(${JSON.stringify(input)}))) == parse(input)`, () => {
      const once = parseSearchQuery(input);
      const formatted = formatSearchQuery(once);
      assert.deepEqual(parseSearchQuery(formatted), once);
      // format is idempotent
      assert.equal(formatSearchQuery(parseSearchQuery(formatted)), formatted);
    });
  }

  it('format(query) re-parses to the same query for a fully populated object', () => {
    const full = q({
      text: 'needle',
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

  it('null / invalid → null', () => {
    assert.equal(resolveSearchDate(null, now), null);
    assert.equal(resolveSearchDate('soon', now), null);
  });

  it('absolute dates resolve to UTC midnight; datetimes pass through', () => {
    assert.equal(resolveSearchDate('2026-10-01', now), '2026-10-01T00:00:00.000Z');
    assert.equal(resolveSearchDate('2026-10-01T12:30:00Z', now), '2026-10-01T12:30:00.000Z');
  });

  it('today / yesterday', () => {
    assert.equal(resolveSearchDate('today', now), '2026-11-05T00:00:00.000Z');
    assert.equal(resolveSearchDate('YESTERDAY', now), '2026-11-04T00:00:00.000Z');
  });

  it('relative units', () => {
    assert.equal(resolveSearchDate('7d', now), '2026-10-29T00:00:00.000Z');
    assert.equal(resolveSearchDate('2w', now), '2026-10-22T00:00:00.000Z');
    assert.equal(resolveSearchDate('1m', now), '2026-10-05T00:00:00.000Z');
    assert.equal(resolveSearchDate('1y', now), '2025-11-05T00:00:00.000Z');
    assert.equal(resolveSearchDate('0d', now), '2026-11-05T00:00:00.000Z');
  });
});
