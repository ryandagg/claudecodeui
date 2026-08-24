import assert from 'node:assert/strict';
import test from 'node:test';

import { computeMerged } from '../useSessionStore';
import type { NormalizedMessage } from '../useSessionStore';

const mk = (over: Partial<NormalizedMessage>): NormalizedMessage => ({
  id: 'x',
  sessionId: 's',
  timestamp: '2026-01-01T00:00:00.000Z',
  provider: 'claude',
  kind: 'text',
  ...over,
});

test('a realtime copy with a different id but the same dedupeKey collapses against the server copy', () => {
  // The exact failing shape: live frame got a random id, the persisted+refetched
  // copy got the transcript-uuid id, but both share the stable dedupeKey.
  const server = [mk({ id: 'uuid_1', dedupeKey: 'msg_X:1', role: 'assistant', content: 'Let me investigate' })];
  const realtime = [mk({ id: 'claude_rand_1', dedupeKey: 'msg_X:1', role: 'assistant', content: 'Let me investigate' })];

  const merged = computeMerged(server, realtime);

  assert.equal(merged.filter((m) => m.content === 'Let me investigate').length, 1);
});

test('realtime-internal duplicates (replay/reconnect) collapse by dedupeKey before the server copy exists', () => {
  const server = [mk({ id: 's1', dedupeKey: 'msg_Y:0', role: 'assistant', content: 'earlier turn' })];
  const dupA = mk({ id: 'claude_a_1', dedupeKey: 'msg_Z:1', role: 'assistant', content: 'live reply' });
  const dupB = mk({ id: 'claude_b_1', dedupeKey: 'msg_Z:1', role: 'assistant', content: 'live reply' });

  const merged = computeMerged(server, [dupA, dupB]);

  assert.equal(merged.filter((m) => m.content === 'live reply').length, 1);
});

test('messages without a dedupeKey keep existing behavior — distinct prompts are not collapsed', () => {
  const realtime = [
    mk({ id: 'local_1', role: 'user', content: 'first prompt' }),
    mk({ id: 'local_2', role: 'user', content: 'second prompt' }),
  ];

  const merged = computeMerged([], realtime);

  assert.equal(merged.length, 2);
});
