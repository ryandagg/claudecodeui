import assert from 'node:assert/strict';
import test from 'node:test';

import { computeInputHistoryNav, type InputHistoryEntry } from './useInputHistory';

const HISTORY: InputHistoryEntry[] = [
  { content: 'first', messageUuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z' },
  { content: 'second', messageUuid: 'u2', timestamp: '2026-01-01T00:01:00.000Z' },
  { content: 'third', messageUuid: 'u3', timestamp: '2026-01-01T00:02:00.000Z' },
];

/** Cursor collapsed at `pos` in a field holding `value`. */
const caret = (key: string, value: string, pos: number) => ({
  key,
  value,
  selectionStart: pos,
  selectionEnd: pos,
});

test('ignores non-arrow keys', () => {
  const nav = computeInputHistoryNav(caret('Enter', '', 0), { index: -1, draft: '' }, HISTORY);
  assert.equal(nav.handled, false);
});

test('ignores arrows when a selection is active', () => {
  const nav = computeInputHistoryNav(
    { key: 'ArrowUp', value: 'abc', selectionStart: 0, selectionEnd: 2 },
    { index: -1, draft: '' },
    HISTORY,
  );
  assert.equal(nav.handled, false);
});

test('ignores arrows when there is no history', () => {
  const nav = computeInputHistoryNav(caret('ArrowUp', '', 0), { index: -1, draft: '' }, []);
  assert.equal(nav.handled, false);
});

test('ArrowUp only fires at cursor position 0', () => {
  const nav = computeInputHistoryNav(caret('ArrowUp', 'draft', 3), { index: -1, draft: '' }, HISTORY);
  assert.equal(nav.handled, false);
});

test('ArrowUp from live draft stashes the draft and jumps to the newest message', () => {
  const nav = computeInputHistoryNav(caret('ArrowUp', 'my draft', 0), { index: -1, draft: '' }, HISTORY);
  assert.equal(nav.handled, true);
  if (!nav.handled) return;
  assert.equal(nav.index, 2);
  assert.equal(nav.draft, 'my draft');
  assert.equal(nav.input, 'third');
  assert.deepEqual(nav.reveal, { uuid: 'u3', timestamp: '2026-01-01T00:02:00.000Z' });
  assert.equal(nav.scrollToBottom, false);
});

test('ArrowUp walks toward older messages', () => {
  const nav = computeInputHistoryNav(caret('ArrowUp', 'third', 0), { index: 2, draft: 'd' }, HISTORY);
  assert.equal(nav.handled, true);
  if (!nav.handled) return;
  assert.equal(nav.index, 1);
  assert.equal(nav.input, 'second');
  assert.deepEqual(nav.reveal, { uuid: 'u2', timestamp: '2026-01-01T00:01:00.000Z' });
});

test('ArrowUp at the oldest message consumes the key but changes nothing (no wrap)', () => {
  const nav = computeInputHistoryNav(caret('ArrowUp', 'first', 0), { index: 0, draft: 'd' }, HISTORY);
  assert.equal(nav.handled, true);
  if (!nav.handled) return;
  assert.equal(nav.index, 0);
  assert.equal(nav.draft, 'd');
  assert.equal(nav.input, null);
  assert.equal(nav.reveal, null);
  assert.equal(nav.scrollToBottom, false);
});

test('ArrowDown does nothing when not navigating', () => {
  const nav = computeInputHistoryNav(caret('ArrowDown', '', 0), { index: -1, draft: '' }, HISTORY);
  assert.equal(nav.handled, false);
});

test('ArrowDown only fires at the end of the text', () => {
  const nav = computeInputHistoryNav(caret('ArrowDown', 'second', 2), { index: 1, draft: 'd' }, HISTORY);
  assert.equal(nav.handled, false);
});

test('ArrowDown walks toward newer messages', () => {
  const nav = computeInputHistoryNav(
    caret('ArrowDown', 'first', 'first'.length),
    { index: 0, draft: 'd' },
    HISTORY,
  );
  assert.equal(nav.handled, true);
  if (!nav.handled) return;
  assert.equal(nav.index, 1);
  assert.equal(nav.input, 'second');
  assert.deepEqual(nav.reveal, { uuid: 'u2', timestamp: '2026-01-01T00:01:00.000Z' });
  assert.equal(nav.scrollToBottom, false);
});

test('ArrowDown past the newest restores the stashed draft and scrolls to bottom', () => {
  const nav = computeInputHistoryNav(
    caret('ArrowDown', 'third', 'third'.length),
    { index: 2, draft: 'my draft' },
    HISTORY,
  );
  assert.equal(nav.handled, true);
  if (!nav.handled) return;
  assert.equal(nav.index, -1);
  assert.equal(nav.input, 'my draft');
  assert.equal(nav.reveal, null);
  assert.equal(nav.scrollToBottom, true);
});

test('a full up-up-down-down round trip returns to the original draft', () => {
  let state = { index: -1, draft: '' };
  const apply = (key: string, value: string, pos: number) => {
    const nav = computeInputHistoryNav(caret(key, value, pos), state, HISTORY);
    assert.equal(nav.handled, true);
    if (!nav.handled) throw new Error('expected handled');
    state = { index: nav.index, draft: nav.draft };
    return nav;
  };

  let nav = apply('ArrowUp', 'orig', 0); // -> third
  assert.equal(nav.input, 'third');
  nav = apply('ArrowUp', 'third', 0); // -> second
  assert.equal(nav.input, 'second');
  nav = apply('ArrowDown', 'second', 'second'.length); // -> third
  assert.equal(nav.input, 'third');
  nav = apply('ArrowDown', 'third', 'third'.length); // -> restore draft
  assert.equal(nav.input, 'orig');
  assert.equal(nav.scrollToBottom, true);
  assert.equal(state.index, -1);
});

test('a stale index past the end is treated as not-navigating (ArrowUp re-stashes from newest)', () => {
  // Index 88 left over from a longer session, now navigating a 3-message one.
  const nav = computeInputHistoryNav(caret('ArrowUp', 'draft', 0), { index: 88, draft: '' }, HISTORY);
  assert.equal(nav.handled, true);
  if (!nav.handled) return;
  assert.equal(nav.index, 2);
  assert.equal(nav.draft, 'draft');
  assert.equal(nav.input, 'third');
});

test('a stale index makes ArrowDown a no-op rather than reading undefined', () => {
  const nav = computeInputHistoryNav(
    caret('ArrowDown', 'whatever', 'whatever'.length),
    { index: 88, draft: '' },
    HISTORY,
  );
  // Normalized to -1 → not navigating → key falls through to the textarea.
  assert.equal(nav.handled, false);
});

test('reveal target omits uuid/timestamp gracefully when the entry lacks them', () => {
  const bare: InputHistoryEntry[] = [{ content: 'only' }];
  const nav = computeInputHistoryNav(caret('ArrowUp', '', 0), { index: -1, draft: '' }, bare);
  assert.equal(nav.handled, true);
  if (!nav.handled) return;
  assert.deepEqual(nav.reveal, { uuid: undefined, timestamp: undefined });
});
