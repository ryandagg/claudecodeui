import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractClaudeSearchableMessage,
  extractClaudeText,
} from '@/modules/providers/services/claude-transcript-text.service.js';

// ---------------------------------------------------------------------------
// extractClaudeText
// ---------------------------------------------------------------------------
test('extractClaudeText returns a plain string as-is', () => {
  assert.equal(extractClaudeText('hello world'), 'hello world');
});

test('extractClaudeText returns empty string for non-array, non-string content', () => {
  assert.equal(extractClaudeText(null), '');
  assert.equal(extractClaudeText(undefined), '');
  assert.equal(extractClaudeText({ type: 'text' }), '');
});

test('extractClaudeText joins text blocks and includes tool names only', () => {
  const content = [
    { type: 'text', text: 'first' },
    { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
    { type: 'text', text: 'second' },
    null,
  ];
  // Tool NAME is indexed; tool arguments (the ls command) are not.
  assert.equal(extractClaudeText(content), 'first Bash second');
});

test('extractClaudeText reads tool_result string content', () => {
  const content = [{ type: 'tool_result', content: 'result body' }];
  assert.equal(extractClaudeText(content), 'result body');
});

test('extractClaudeText reads tool_result nested text blocks', () => {
  const content = [
    { type: 'tool_result', content: [{ type: 'text', text: 'nested one' }, { type: 'image' }, { type: 'text', text: 'nested two' }] },
  ];
  assert.equal(extractClaudeText(content), 'nested one nested two');
});

test('extractClaudeText truncates a pathologically long tool_result string', () => {
  const huge = 'x'.repeat(20_000);
  const content = [{ type: 'tool_result', content: huge }];
  assert.equal(extractClaudeText(content).length, 10_000);
});

// ---------------------------------------------------------------------------
// extractClaudeSearchableMessage
// ---------------------------------------------------------------------------
test('extractClaudeSearchableMessage returns null when content or role is unusable', () => {
  assert.equal(extractClaudeSearchableMessage({}), null);
  assert.equal(extractClaudeSearchableMessage({ message: {} }), null);
  assert.equal(extractClaudeSearchableMessage({ message: { content: 'hi', role: 'system' } }), null);
  assert.equal(extractClaudeSearchableMessage({ isApiErrorMessage: true, message: { content: 'x', role: 'user' } }), null);
});

test('extractClaudeSearchableMessage passes through plain user/assistant text', () => {
  assert.deepEqual(
    extractClaudeSearchableMessage({ message: { content: 'what is up', role: 'user' } }),
    { text: 'what is up', role: 'user' },
  );
  assert.deepEqual(
    extractClaudeSearchableMessage({ message: { content: 'here you go', role: 'assistant' } }),
    { text: 'here you go', role: 'assistant' },
  );
});

test('extractClaudeSearchableMessage relabels a compact summary as assistant', () => {
  const result = extractClaudeSearchableMessage({
    isCompactSummary: true,
    message: { content: 'summary of the chat', role: 'user' },
  });
  assert.deepEqual(result, { text: 'summary of the chat', role: 'assistant' });
});

test('extractClaudeSearchableMessage renders a local-command wrapper as the command run', () => {
  const content = '<command-name>/deploy</command-name><command-args>prod --force</command-args>';
  assert.deepEqual(
    extractClaudeSearchableMessage({ message: { content, role: 'user' } }),
    { text: '/deploy prod --force', role: 'user' },
  );
});

test('extractClaudeSearchableMessage strips ANSI from local-command stdout', () => {
  const content = '<local-command-stdout>\x1B[31mred output\x1B[0m</local-command-stdout>';
  const result = extractClaudeSearchableMessage({ message: { content, role: 'user' } });
  assert.equal(result?.role, 'assistant');
  assert.equal(result?.text, 'red output');
});

test('extractClaudeSearchableMessage drops internal/synthetic rows', () => {
  assert.equal(
    extractClaudeSearchableMessage({ message: { content: '<system-reminder>hidden</system-reminder>', role: 'user' } }),
    null,
  );
  assert.equal(
    extractClaudeSearchableMessage({ message: { content: 'Caveat: the following is auto-generated', role: 'user' } }),
    null,
  );
  assert.equal(
    extractClaudeSearchableMessage({ message: { content: '', role: 'user' } }),
    null,
  );
});

test('extractClaudeSearchableMessage extracts text from block-array content', () => {
  const result = extractClaudeSearchableMessage({
    message: { content: [{ type: 'text', text: 'block text' }], role: 'assistant' },
  });
  assert.deepEqual(result, { text: 'block text', role: 'assistant' });
});

test('extractClaudeSearchableMessage drops internal block-array content', () => {
  const result = extractClaudeSearchableMessage({
    message: { content: [{ type: 'text', text: '<task-notification>done</task-notification>' }], role: 'assistant' },
  });
  assert.equal(result, null);
});
