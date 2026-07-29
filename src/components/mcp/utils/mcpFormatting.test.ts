import assert from 'node:assert/strict';
import test from 'node:test';

import type { McpFormState } from '../types';

import {
  createMcpPayloadFromForm,
  formatKeyValueLines,
  getErrorMessage,
  getProjectPath,
  isMcpScope,
  isMcpTransport,
  maskSecret,
  parseJsonMcpPayload,
  parseKeyValueLines,
  parseListLines,
} from './mcpFormatting';

// A complete default form; individual tests override just the fields they need.
const baseForm = (overrides: Partial<McpFormState> = {}): McpFormState => ({
  name: 'my-server',
  scope: 'project',
  workspacePath: '/ws',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'pkg'],
  env: { API_KEY: 'secret' },
  cwd: '/ws/sub',
  url: '',
  headers: {},
  envVars: [],
  bearerTokenEnvVar: '',
  envHttpHeaders: {},
  importMode: 'form',
  jsonInput: '',
  ...overrides,
});

// ---------------------------------------------------------------------------
// key/value + list line helpers
// ---------------------------------------------------------------------------
test('formatKeyValueLines and parseKeyValueLines round-trip', () => {
  const map = { A: '1', B: 'two=parts' };
  const text = formatKeyValueLines(map);
  assert.equal(text, 'A=1\nB=two=parts');
  assert.deepEqual(parseKeyValueLines(text), map);
});

test('parseKeyValueLines ignores blank keys and trims', () => {
  assert.deepEqual(parseKeyValueLines('  X = 1 \n\n=orphan\nY=2'), { X: '1', Y: '2' });
});

test('parseListLines trims and drops empty entries', () => {
  assert.deepEqual(parseListLines('a\n  b  \n\n c'), ['a', 'b', 'c']);
});

// ---------------------------------------------------------------------------
// maskSecret
// ---------------------------------------------------------------------------
test('maskSecret hides short values entirely and partially reveals long ones', () => {
  assert.equal(maskSecret('abcd'), '****');
  assert.equal(maskSecret('abcdefgh'), 'ab****gh');
  assert.equal(maskSecret(null), '****');
});

// ---------------------------------------------------------------------------
// type guards + small getters
// ---------------------------------------------------------------------------
test('isMcpScope and isMcpTransport narrow known literals', () => {
  assert.equal(isMcpScope('user'), true);
  assert.equal(isMcpScope('nope'), false);
  assert.equal(isMcpTransport('stdio'), true);
  assert.equal(isMcpTransport('grpc'), false);
});

test('getProjectPath prefers fullPath then path', () => {
  assert.equal(getProjectPath({ fullPath: '/a', path: '/b' }), '/a');
  assert.equal(getProjectPath({ path: '/b' }), '/b');
  assert.equal(getProjectPath({}), '');
});

test('getErrorMessage unwraps Error instances', () => {
  assert.equal(getErrorMessage(new Error('bad')), 'bad');
  assert.equal(getErrorMessage('a string'), 'Unknown error');
});

// ---------------------------------------------------------------------------
// createMcpPayloadFromForm — form mode
// ---------------------------------------------------------------------------
test('createMcpPayloadFromForm builds a stdio payload and omits url/headers', () => {
  const payload = createMcpPayloadFromForm('claude', baseForm());
  assert.equal(payload.transport, 'stdio');
  assert.equal(payload.command, 'npx');
  assert.deepEqual(payload.args, ['-y', 'pkg']);
  assert.equal(payload.url, undefined);
  // scope !== 'user' keeps workspacePath
  assert.equal(payload.workspacePath, '/ws');
});

test('createMcpPayloadFromForm builds an http payload and omits command/args', () => {
  const payload = createMcpPayloadFromForm(
    'claude',
    baseForm({ transport: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } }),
  );
  assert.equal(payload.transport, 'http');
  assert.equal(payload.url, 'https://x/mcp');
  assert.deepEqual(payload.headers, { Authorization: 'Bearer t' });
  assert.equal(payload.command, undefined);
  assert.equal(payload.args, undefined);
});

test('createMcpPayloadFromForm drops workspacePath for user scope', () => {
  const payload = createMcpPayloadFromForm('claude', baseForm({ scope: 'user' }));
  assert.equal(payload.workspacePath, undefined);
});

test('createMcpPayloadFromForm rejects an unsupported transport for the provider', () => {
  // claude supports stdio/http/sse, so simulate an unsupported one via options.
  assert.throws(
    () => createMcpPayloadFromForm('claude', baseForm(), { supportedTransports: ['http'] }),
    /claude does not support stdio/,
  );
});

// ---------------------------------------------------------------------------
// parseJsonMcpPayload — JSON import mode
// ---------------------------------------------------------------------------
test('parseJsonMcpPayload reads a stdio server from JSON', () => {
  const form = baseForm({
    importMode: 'json',
    jsonInput: JSON.stringify({ type: 'stdio', command: 'node', args: ['server.js'], env: { A: '1' } }),
  });
  const payload = parseJsonMcpPayload('claude', form);
  assert.equal(payload.transport, 'stdio');
  assert.equal(payload.command, 'node');
  assert.deepEqual(payload.args, ['server.js']);
  assert.deepEqual(payload.env, { A: '1' });
});

test('parseJsonMcpPayload accepts transport under either "type" or "transport"', () => {
  const payload = parseJsonMcpPayload(
    'claude',
    baseForm({ importMode: 'json', jsonInput: JSON.stringify({ transport: 'http', url: 'https://x' }) }),
  );
  assert.equal(payload.transport, 'http');
  assert.equal(payload.url, 'https://x');
});

test('parseJsonMcpPayload enforces required fields per transport', () => {
  assert.throws(
    () => parseJsonMcpPayload('claude', baseForm({ importMode: 'json', jsonInput: JSON.stringify({ type: 'stdio' }) })),
    /stdio type requires a command/,
  );
  assert.throws(
    () => parseJsonMcpPayload('claude', baseForm({ importMode: 'json', jsonInput: JSON.stringify({ type: 'http' }) })),
    /http type requires a url/,
  );
  assert.throws(
    () => parseJsonMcpPayload('claude', baseForm({ importMode: 'json', jsonInput: JSON.stringify({ command: 'x' }) })),
    /Missing required field: type/,
  );
  assert.throws(
    () => parseJsonMcpPayload('claude', baseForm({ importMode: 'json', jsonInput: '[]' })),
    /must be an object/,
  );
});
