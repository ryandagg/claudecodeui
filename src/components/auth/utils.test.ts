import assert from 'node:assert/strict';
import test from 'node:test';

import { parseJsonSafely, resolveApiErrorMessage } from './utils';

test('parseJsonSafely returns parsed JSON on success', async () => {
  const response = { json: async () => ({ ok: true }) } as unknown as Response;
  assert.deepEqual(await parseJsonSafely(response), { ok: true });
});

test('parseJsonSafely returns null when the body is not JSON', async () => {
  const response = {
    json: async () => {
      throw new SyntaxError('Unexpected token');
    },
  } as unknown as Response;
  assert.equal(await parseJsonSafely(response), null);
});

test('resolveApiErrorMessage prefers error, then message, then fallback', () => {
  assert.equal(resolveApiErrorMessage({ error: 'boom', message: 'ignored' }, 'fb'), 'boom');
  assert.equal(resolveApiErrorMessage({ message: 'msg' }, 'fb'), 'msg');
  assert.equal(resolveApiErrorMessage({}, 'fb'), 'fb');
  assert.equal(resolveApiErrorMessage(null, 'fb'), 'fb');
});
