import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEARCH_TABS,
  buildMessageHitSelection,
  createDoubleShiftDetector,
  cycleTab,
  filterAndRank,
  isSearchEverywhereEnabled,
  isTypingTarget,
  matchesAllTerms,
  splitHighlights,
  tabForBinding,
  visibleTabs,
  type MessageHit,
  type SearchTabId,
} from '../searchEverywhereModel';

const storage = (value: string | null) => ({ getItem: () => value });

describe('isSearchEverywhereEnabled', () => {
  it('defaults OFF', () => {
    assert.equal(isSearchEverywhereEnabled(storage(null)), false);
    assert.equal(isSearchEverywhereEnabled(null), false);
    assert.equal(isSearchEverywhereEnabled(storage('')), false);
    assert.equal(isSearchEverywhereEnabled(storage('0')), false);
    assert.equal(isSearchEverywhereEnabled(storage('false')), false);
  });
  it('accepts truthy strings', () => {
    for (const v of ['1', 'true', 'TRUE', ' on ', 'yes']) {
      assert.equal(isSearchEverywhereEnabled(storage(v)), true, v);
    }
  });
  it('survives storage that throws', () => {
    assert.equal(isSearchEverywhereEnabled({ getItem: () => { throw new Error('denied'); } }), false);
  });
});

describe('tabs', () => {
  const available = new Set<SearchTabId>(['all', 'sessions', 'messages', 'files', 'actions', 'git']);
  const tabs = visibleTabs(available);

  it('hides tabs without a source and keeps registry order', () => {
    assert.deepEqual(tabs.map((t) => t.id), ['all', 'sessions', 'messages', 'files', 'actions', 'git']);
  });
  it('cycles forward and backward with wrap', () => {
    assert.equal(cycleTab(tabs, 'all', 1), 'sessions');
    assert.equal(cycleTab(tabs, 'git', 1), 'all');
    assert.equal(cycleTab(tabs, 'all', -1), 'git');
    assert.equal(cycleTab(tabs, 'text', 1), 'all', 'unknown current resets to first');
    assert.equal(cycleTab([], 'all', 1), 'all');
  });
  it('maps bindings to visible tabs only', () => {
    assert.equal(tabForBinding(tabs, 'mod+alt+o'), 'files');
    assert.equal(tabForBinding(tabs, 'mod+alt+t'), null, 'text hidden');
    assert.equal(tabForBinding(tabs, null), null);
    assert.equal(tabForBinding(tabs, 'mod+k'), null);
  });
  it('has unique shortcuts', () => {
    const shortcuts = SEARCH_TABS.map((t) => t.shortcut).filter(Boolean);
    assert.equal(new Set(shortcuts).size, shortcuts.length);
  });
});

describe('createDoubleShiftDetector', () => {
  const down = (t: number, key = 'Shift', repeat = false) => ({ type: 'keydown' as const, key, timeStamp: t, repeat });
  const up = (t: number, key = 'Shift') => ({ type: 'keyup' as const, key, timeStamp: t });

  it('fires on two clean taps within the window', () => {
    const feed = createDoubleShiftDetector(400);
    assert.equal(feed(down(0)), false);
    assert.equal(feed(up(50)), false);
    assert.equal(feed(down(150)), false);
    assert.equal(feed(up(200)), true);
  });
  it('does not fire when taps are too far apart', () => {
    const feed = createDoubleShiftDetector(400);
    feed(down(0)); feed(up(50));
    feed(down(600));
    assert.equal(feed(up(650)), false);
    // ...but the late tap starts a new pair
    feed(down(700));
    assert.equal(feed(up(750)), true);
  });
  it('ignores Shift used as a modifier (Shift+A)', () => {
    const feed = createDoubleShiftDetector(400);
    feed(down(0)); feed(down(10, 'A')); feed(up(20, 'A')); feed(up(30));
    feed(down(100));
    assert.equal(feed(up(150)), false);
  });
  it('a key typed between taps breaks the pair', () => {
    const feed = createDoubleShiftDetector(400);
    feed(down(0)); feed(up(30));
    feed(down(60, 'x'));
    feed(down(100));
    assert.equal(feed(up(130)), false);
  });
  it('ignores key-repeat while Shift is held', () => {
    const feed = createDoubleShiftDetector(400);
    feed(down(0)); feed(down(30, 'Shift', true)); feed(down(60, 'Shift', true));
    assert.equal(feed(up(90)), false);
    feed(down(150));
    assert.equal(feed(up(180)), true);
  });
  it('does not fire a third time from one extra tap', () => {
    const feed = createDoubleShiftDetector(400);
    feed(down(0)); feed(up(20)); feed(down(40));
    assert.equal(feed(up(60)), true);
    feed(down(80));
    assert.equal(feed(up(100)), false);
  });
  it('keyup without keydown is ignored', () => {
    const feed = createDoubleShiftDetector(400);
    assert.equal(feed(up(10)), false);
  });
});

describe('isTypingTarget', () => {
  it('treats inputs, textareas, selects and contenteditable as typing', () => {
    assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
    assert.equal(isTypingTarget({ tagName: 'textarea' }), true);
    assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
    assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  });
  it('treats xterm / CodeMirror descendants as typing', () => {
    const inside = { tagName: 'DIV', closest: (sel: string) => (sel.includes('.xterm') ? {} : null) };
    assert.equal(isTypingTarget(inside), true);
  });
  it('plain elements and null are not typing', () => {
    assert.equal(isTypingTarget({ tagName: 'BODY', closest: () => null }), false);
    assert.equal(isTypingTarget(null), false);
    assert.equal(isTypingTarget('x'), false);
  });
});

describe('matching', () => {
  it('requires every term in some field', () => {
    assert.equal(matchesAllTerms('fix bug', 'Fix the login', 'bug in auth'), true);
    assert.equal(matchesAllTerms('fix bug', 'Fix the login'), false);
    assert.equal(matchesAllTerms('   ', 'anything'), true);
    assert.equal(matchesAllTerms('a', null, undefined), false);
  });
  it('ranks exact > prefix > word start > substring, stable on ties', () => {
    const items = ['my-setup', 'setup.ts', 'reset', 'setup', 'set up', 'resetup'];
    const ranked = filterAndRank(items, 'setup', (s) => s);
    assert.deepEqual(ranked, ['setup', 'setup.ts', 'my-setup', 'resetup']);
  });
  it('returns a copy unfiltered for an empty query', () => {
    const items = ['b', 'a'];
    const out = filterAndRank(items, '', (s) => s);
    assert.deepEqual(out, items);
    assert.notEqual(out, items);
  });
  it('matches on extra fields without ranking them', () => {
    const out = filterAndRank([{ l: 'Open settings', k: 'preferences' }], 'pref', (x) => x.l, (x) => [x.k]);
    assert.equal(out.length, 1);
  });
  it('escapes regex metacharacters in the query', () => {
    assert.deepEqual(filterAndRank(['a.(b', 'zz'], '(b', (s) => s), ['a.(b']);
  });
});

describe('buildMessageHitSelection', () => {
  const hit: MessageHit = {
    projectId: 'p1',
    projectName: 'proj',
    sessionId: 's1',
    provider: 'codex',
    sessionSummary: 'Index title',
    isArchived: false,
    snippet: '…the needle…',
    highlights: [{ start: 4, end: 10 }],
    role: 'user',
    timestamp: '2026-11-01T00:00:00Z',
    messageUuid: 'u-1',
  };

  it('targets the loaded session and carries search-target fields', () => {
    const projects = [{ projectId: 'p1', sessions: [{ id: 's1', summary: 'Loaded title', extra: 1 }] }];
    const { project, session } = buildMessageHitSelection(hit, projects, 'needle');
    assert.equal(project, projects[0]);
    assert.equal(session.id, 's1');
    assert.equal(session.summary, 'Loaded title');
    assert.equal(session.extra, 1);
    assert.equal(session.__provider, 'codex');
    assert.equal(session.__projectId, 'p1');
    assert.equal(session.__searchTargetUuid, 'u-1');
    assert.equal(session.__searchTargetSnippet, '…the needle…');
    assert.equal(session.__searchTargetTimestamp, '2026-11-01T00:00:00Z');
    assert.equal(session.__searchQuery, 'needle');
    assert.equal(session.__isArchived, false);
  });
  it('falls back to index title and hit project when not loaded', () => {
    const { project, session } = buildMessageHitSelection({ ...hit, messageUuid: null, isArchived: true }, [], '');
    assert.equal(project, null);
    assert.equal(session.summary, 'Index title');
    assert.equal(session.__projectId, 'p1');
    assert.equal(session.__searchTargetUuid, null);
    assert.equal(session.__searchQuery, null);
    assert.equal(session.__isArchived, true);
  });
});

describe('splitHighlights', () => {
  it('splits into runs', () => {
    assert.deepEqual(splitHighlights('abcdef', [{ start: 1, end: 3 }]), [
      { text: 'a', match: false },
      { text: 'bc', match: true },
      { text: 'def', match: false },
    ]);
  });
  it('sorts, clamps, and drops overlapping/empty/out-of-range ranges', () => {
    assert.deepEqual(
      splitHighlights('abcdef', [{ start: 4, end: 99 }, { start: 0, end: 2 }, { start: 1, end: 3 }, { start: 3, end: 3 }, { start: 50, end: 60 }]),
      [
        { text: 'ab', match: true },
        { text: 'c', match: true },
        { text: 'd', match: false },
        { text: 'ef', match: true },
      ],
    );
  });
  it('no highlights → single plain run; empty text → nothing', () => {
    assert.deepEqual(splitHighlights('abc', []), [{ text: 'abc', match: false }]);
    assert.deepEqual(splitHighlights('', []), []);
  });
});
