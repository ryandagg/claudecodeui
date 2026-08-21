import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseModelLimits,
  resolveContextLimit,
} from '@/modules/providers/list/claude/claude-model-limits.provider.js';

// ---------------------------------------------------------------------------
// parseModelLimits — shape the gateway /v1/models response into id -> window.
// (A trimmed sample of the real gateway payload.)
// ---------------------------------------------------------------------------
const SAMPLE = {
  data: [
    { id: 'claude-opus-4-8', object: 'model', max_input_tokens: 1_000_000, max_output_tokens: 128_000 },
    { id: 'claude-sonnet-5', object: 'model', max_input_tokens: 1_000_000, max_output_tokens: 64_000 },
    { id: 'claude-haiku-4-5-20251001', object: 'model', max_input_tokens: 200_000, max_output_tokens: 64_000 },
    // No max_input_tokens (some -vertex variants): omitted from the map.
    { id: 'claude-opus-4-8-vertex', object: 'model' },
  ],
  object: 'list',
};

test('parseModelLimits maps id -> max_input_tokens and skips entries without one', () => {
  const limits = parseModelLimits(SAMPLE);
  assert.deepEqual(limits, {
    'claude-opus-4-8': 1_000_000,
    'claude-sonnet-5': 1_000_000,
    'claude-haiku-4-5-20251001': 200_000,
  });
  assert.equal('claude-opus-4-8-vertex' in limits, false);
});

test('parseModelLimits returns an empty map for malformed input', () => {
  assert.deepEqual(parseModelLimits(null), {});
  assert.deepEqual(parseModelLimits({}), {});
  assert.deepEqual(parseModelLimits({ data: 'nope' }), {});
  assert.deepEqual(parseModelLimits({ data: [{ id: 'x', max_input_tokens: 0 }] }), {});
  assert.deepEqual(parseModelLimits({ data: [{ id: 'x', max_input_tokens: 'huge' }] }), {});
});

// ---------------------------------------------------------------------------
// resolveContextLimit — map a session/env model string to its window.
// ---------------------------------------------------------------------------
const LIMITS = parseModelLimits(SAMPLE);

test('resolveContextLimit matches a bare gateway id directly (JSONL model)', () => {
  assert.equal(resolveContextLimit(LIMITS, 'claude-opus-4-8'), 1_000_000);
});

test('resolveContextLimit strips the us.anthropic. prefix and [1m] marker (env default)', () => {
  assert.equal(resolveContextLimit(LIMITS, 'us.anthropic.claude-opus-4-8[1m]'), 1_000_000);
});

test('resolveContextLimit strips a Bedrock -vN:N version suffix', () => {
  assert.equal(
    resolveContextLimit(LIMITS, 'us.anthropic.claude-haiku-4-5-20251001-v1:0'),
    200_000,
  );
});

test('resolveContextLimit returns null for unknown models and empty input', () => {
  assert.equal(resolveContextLimit(LIMITS, 'claude-opus-4-8-vertex'), null);
  assert.equal(resolveContextLimit(LIMITS, 'gpt-5.6-sol'), null);
  assert.equal(resolveContextLimit(LIMITS, ''), null);
  assert.equal(resolveContextLimit(LIMITS, null), null);
  assert.equal(resolveContextLimit(LIMITS, undefined), null);
});

test('resolveContextLimit against an empty map is always null', () => {
  assert.equal(resolveContextLimit({}, 'claude-opus-4-8'), null);
});
