import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';

import { groupConsecutiveTools, isToolGroupItem, rendersNothing } from './toolGrouping';

const msg = (overrides: Partial<ChatMessage>): ChatMessage => ({
  type: 'assistant',
  timestamp: '2026-01-01T00:00:00.000Z',
  ...overrides,
}) as ChatMessage;

const tool = (name: string, extra: Partial<ChatMessage> = {}) =>
  msg({ type: 'tool', isToolUse: true, toolName: name, ...extra });

// ---------------------------------------------------------------------------
// rendersNothing
// ---------------------------------------------------------------------------
test('rendersNothing hides thinking messages only when thinking is off', () => {
  const thinking = msg({ isThinking: true });
  assert.equal(rendersNothing(thinking, false), true);
  assert.equal(rendersNothing(thinking, true), false);
  assert.equal(rendersNothing(msg({}), false), false);
});

// ---------------------------------------------------------------------------
// groupConsecutiveTools
// ---------------------------------------------------------------------------
test('groupConsecutiveTools groups a run of same-named tools at/above threshold', () => {
  const items = groupConsecutiveTools([tool('Bash'), tool('Bash'), tool('Bash')]);
  assert.equal(items.length, 1);
  assert.equal(isToolGroupItem(items[0]), true);
  if (isToolGroupItem(items[0])) {
    assert.equal(items[0].toolName, 'Bash');
    assert.equal(items[0].messages.length, 3);
  }
});

test('groupConsecutiveTools leaves a single tool ungrouped', () => {
  const items = groupConsecutiveTools([tool('Read')]);
  assert.equal(items.length, 1);
  assert.equal(isToolGroupItem(items[0]), false);
});

test('groupConsecutiveTools breaks runs when the tool name changes', () => {
  const items = groupConsecutiveTools([tool('Bash'), tool('Bash'), tool('Read')]);
  // [group(Bash x2), Read]
  assert.equal(items.length, 2);
  assert.equal(isToolGroupItem(items[0]), true);
  assert.equal(isToolGroupItem(items[1]), false);
});

test('groupConsecutiveTools keeps non-tool messages between runs', () => {
  const items = groupConsecutiveTools([
    msg({ type: 'user', content: 'hi' }),
    tool('Bash'),
    tool('Bash'),
    msg({ type: 'assistant', content: 'done' }),
  ]);
  assert.equal(items.length, 3);
  assert.equal(isToolGroupItem(items[0]), false);
  assert.equal(isToolGroupItem(items[1]), true);
  assert.equal(isToolGroupItem(items[2]), false);
});

test('groupConsecutiveTools skips hidden thinking messages inside a run', () => {
  const items = groupConsecutiveTools(
    [tool('Bash'), msg({ isThinking: true }), tool('Bash')],
    false, // thinking hidden → the thinking message does not break the run
  );
  assert.equal(items.length, 1);
  assert.equal(isToolGroupItem(items[0]), true);
});

test('groupConsecutiveTools does not group subagent containers', () => {
  const items = groupConsecutiveTools([
    tool('Task', { isSubagentContainer: true }),
    tool('Task', { isSubagentContainer: true }),
  ]);
  assert.equal(items.length, 2);
  assert.equal(items.every((item) => !isToolGroupItem(item)), true);
});
