import assert from 'node:assert/strict';
import test from 'node:test';

import { extractTokenBudget } from '@/modules/providers/list/claude/claude-token-budget.js';

// ---------------------------------------------------------------------------
// Real assistant frame: message.usage with input + output + cache read.
// This is the frame the "% until auto-compaction" button should reflect.
// ---------------------------------------------------------------------------
test('extractTokenBudget sums input, output, and cache tokens from message.usage', () => {
  const budget = extractTokenBudget({
    type: 'assistant',
    message: {
      usage: {
        input_tokens: 2,
        output_tokens: 14,
        cache_read_input_tokens: 56812,
        cache_creation_input_tokens: 0,
      },
    },
  });

  assert.ok(budget, 'expected a budget for a populated assistant frame');
  assert.equal(budget?.used, 56828); // (2 + 56812) input + 14 output
  assert.equal(budget?.inputTokens, 56814);
  assert.equal(budget?.outputTokens, 14);
  assert.equal(budget?.cacheReadTokens, 56812);
  assert.equal(budget?.cacheCreationTokens, 0);
  assert.equal(budget?.cacheTokens, 56812);
  assert.deepEqual(budget?.breakdown, { input: 56814, output: 14 });
});

test('extractTokenBudget reads a top-level usage object (result-style frame)', () => {
  const budget = extractTokenBudget({
    type: 'result',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
  });

  assert.ok(budget);
  assert.equal(budget?.used, 120);
});

// ---------------------------------------------------------------------------
// The bug this module fixes: the terminal `result` frame carries an empty or
// all-zero usage object. Returning used:0 from it would clobber the assistant
// frame's real reading (live send + deferred auto-compact re-emit). It must be
// treated as "no data" (null) so the last real reading stands.
// ---------------------------------------------------------------------------
test('extractTokenBudget returns null for an empty usage object', () => {
  assert.equal(extractTokenBudget({ type: 'result', subtype: 'success', usage: {} }), null);
});

test('extractTokenBudget returns null for an all-zero usage object', () => {
  const zeroed = extractTokenBudget({
    type: 'result',
    subtype: 'success',
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });
  assert.equal(zeroed, null);
});

test('extractTokenBudget does not fall through to modelUsage when a zero usage object is present', () => {
  // A present-but-zero `usage` object short-circuits to null; the (cumulative,
  // and thus too-large) modelUsage fallback must not be used to fill it in.
  const budget = extractTokenBudget({
    type: 'result',
    usage: {},
    modelUsage: { 'claude-opus-4-8': { cumulativeInputTokens: 999999, cumulativeOutputTokens: 111 } },
  });
  assert.equal(budget, null);
});

// ---------------------------------------------------------------------------
// Non-usable inputs.
// ---------------------------------------------------------------------------
test('extractTokenBudget returns null for non-object / empty inputs', () => {
  assert.equal(extractTokenBudget(null), null);
  assert.equal(extractTokenBudget(undefined), null);
  assert.equal(extractTokenBudget('nope'), null);
  assert.equal(extractTokenBudget(42), null);
  assert.equal(extractTokenBudget({ type: 'system' }), null); // no usage, no modelUsage
});

// ---------------------------------------------------------------------------
// Legacy fallback: messages that only carry modelUsage.
// ---------------------------------------------------------------------------
test('extractTokenBudget falls back to modelUsage when no usage object is present', () => {
  const budget = extractTokenBudget({
    modelUsage: {
      'claude-opus-4-8': { cumulativeInputTokens: 1000, cumulativeOutputTokens: 250 },
    },
  });

  assert.ok(budget);
  assert.equal(budget?.used, 1250);
  assert.equal(budget?.inputTokens, 1000);
  assert.equal(budget?.outputTokens, 250);
});

test('extractTokenBudget returns null for a zero or empty modelUsage', () => {
  assert.equal(
    extractTokenBudget({ modelUsage: { m: { cumulativeInputTokens: 0, cumulativeOutputTokens: 0 } } }),
    null,
  );
  assert.equal(extractTokenBudget({ modelUsage: {} }), null);
});

// ---------------------------------------------------------------------------
// The legacy `total` field tracks the CONTEXT_WINDOW env (default 160000).
// ---------------------------------------------------------------------------
test('extractTokenBudget reports the context window in `total`', () => {
  const previous = process.env.CONTEXT_WINDOW;
  try {
    delete process.env.CONTEXT_WINDOW;
    assert.equal(extractTokenBudget({ usage: { input_tokens: 5, output_tokens: 5 } })?.total, 160000);

    process.env.CONTEXT_WINDOW = '200000';
    assert.equal(extractTokenBudget({ usage: { input_tokens: 5, output_tokens: 5 } })?.total, 200000);
  } finally {
    if (previous === undefined) {
      delete process.env.CONTEXT_WINDOW;
    } else {
      process.env.CONTEXT_WINDOW = previous;
    }
  }
});
