import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';

import { getIntrinsicMessageKey } from './messageKeys';

const msg = (overrides: Partial<ChatMessage>): ChatMessage => ({
  type: 'assistant',
  timestamp: '2026-01-01T00:00:00.000Z',
  ...overrides,
}) as ChatMessage;

test('getIntrinsicMessageKey prefers id and includes the message type', () => {
  assert.equal(getIntrinsicMessageKey(msg({ id: 'abc' })), 'message-assistant-abc');
});

test('getIntrinsicMessageKey falls through the identifier candidates in order', () => {
  assert.equal(getIntrinsicMessageKey(msg({ messageId: 'm1' })), 'message-assistant-m1');
  assert.equal(getIntrinsicMessageKey(msg({ toolId: 't1' })), 'message-assistant-t1');
  assert.equal(getIntrinsicMessageKey(msg({ rowid: 42 })), 'message-assistant-42');
});

test('getIntrinsicMessageKey ignores blank candidates and uses the next one', () => {
  assert.equal(getIntrinsicMessageKey(msg({ id: '   ', toolCallId: 'call-1' })), 'message-assistant-call-1');
});

test('getIntrinsicMessageKey composes a fallback key from timestamp, tool and content', () => {
  const key = getIntrinsicMessageKey(
    msg({ type: 'tool', timestamp: '2026-01-01T00:00:00.000Z', toolName: 'Bash', content: 'ls -la' }),
  );
  const ts = new Date('2026-01-01T00:00:00.000Z').getTime();
  assert.equal(key, `message-tool-${ts}-Bash-ls -la`);
});

test('getIntrinsicMessageKey returns null when no id and the timestamp is invalid', () => {
  assert.equal(getIntrinsicMessageKey(msg({ timestamp: 'not-a-date' })), null);
});
