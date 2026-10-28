import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const provider = new ClaudeSessionsProvider();

// One assistant turn, shaped as it appears on each data path. The live SDK
// event has no transcript `uuid` (so `id` falls back to a random value), while
// the persisted transcript row carries `uuid`. Both carry the SAME API
// `message.id`, which is what `dedupeKey` is derived from.
const API_MESSAGE_ID = 'msg_bdrk_TEST';
const assistantContent = [
  { type: 'thinking', thinking: 'reasoning...', signature: 'sig' },
  { type: 'text', text: 'Let me investigate' },
  { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
];
const liveEvent = {
  type: 'assistant',
  message: { id: API_MESSAGE_ID, role: 'assistant', content: assistantContent },
  timestamp: '2026-01-01T00:00:00.000Z',
};
const persistedRow = { ...liveEvent, uuid: 'b0-uuid' };

test('assistant dedupeKey is identical across the live and persisted paths, while id differs', () => {
  const liveMsgs = provider.normalizeMessage(liveEvent, 'sid');
  const persistedMsgs = provider.normalizeMessage(persistedRow, 'sid');

  // Same three frames, same dedupeKeys, regardless of path.
  assert.deepEqual(
    liveMsgs.map((m) => m.dedupeKey),
    [`${API_MESSAGE_ID}:0`, `${API_MESSAGE_ID}:1`, 'tool:toolu_1'],
  );
  assert.deepEqual(
    liveMsgs.map((m) => m.dedupeKey),
    persistedMsgs.map((m) => m.dedupeKey),
  );

  // Text block keyed by message-id + part index; tool_use by its own stable id.
  assert.equal(liveMsgs.find((m) => m.kind === 'text')?.dedupeKey, `${API_MESSAGE_ID}:1`);
  assert.equal(liveMsgs.find((m) => m.kind === 'tool_use')?.dedupeKey, 'tool:toolu_1');

  // The whole point: `id` does NOT match across paths, so dedupeKey — not id —
  // is what lets the frontend collapse the duplicate.
  const liveText = liveMsgs.find((m) => m.kind === 'text');
  const persistedText = persistedMsgs.find((m) => m.kind === 'text');
  assert.notEqual(liveText?.id, persistedText?.id);
});

test('user messages carry no dedupeKey (they fall back to existing echo dedup)', () => {
  const userRow = {
    type: 'user',
    uuid: 'u1',
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    timestamp: '2026-01-01T00:00:00.000Z',
  };
  const msgs = provider.normalizeMessage(userRow, 'sid');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].dedupeKey, undefined);
});

test('api-request-blob entries never become ghost user messages', () => {
  // The raw request payload sent to the model is persisted as an
  // `api-request-blob`: it carries `message.role: 'user'` with the prompt text,
  // but no `uuid` and no `timestamp`. If normalized, it would become a ghost
  // duplicate with a freshly generated id + `new Date()` stamp on every read —
  // one that epoch-sorts to the top server-side and flips to the bottom on the
  // client. It must produce nothing.
  const blob = {
    type: 'api-request-blob',
    sessionId: 'sid',
    hash: 'abc123',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>context</system-reminder>' },
        { type: 'text', text: 'Write the numbers 1 to 40' },
      ],
    },
  };
  assert.deepEqual(provider.normalizeMessage(blob, 'sid'), []);
});

test('transcript bookkeeping entries are skipped, real turns are not', () => {
  const bookkeeping = [
    { type: 'queue-operation', operation: 'enqueue', sessionId: 'sid', timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'last-prompt', lastPrompt: 'Write the numbers 1 to 40', leafUuid: 'x', sessionId: 'sid' },
    { type: 'cost-state', sessionId: 'sid' },
    { type: 'api-request', sessionId: 'sid' },
  ];
  for (const entry of bookkeeping) {
    assert.deepEqual(provider.normalizeMessage(entry, 'sid'), [], `expected ${entry.type} to yield no messages`);
  }

  // A genuine user turn still normalizes to exactly one message with a stable,
  // uuid-derived id (not a generated `claude_` ghost id).
  const userRow = {
    type: 'user',
    uuid: 'u-real',
    message: { role: 'user', content: [{ type: 'text', text: 'Write the numbers 1 to 40' }] },
    timestamp: '2026-01-01T00:00:00.000Z',
  };
  const msgs = provider.normalizeMessage(userRow, 'sid');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].content, 'Write the numbers 1 to 40');
  assert.ok(!msgs[0].id.startsWith('claude_'));
});
