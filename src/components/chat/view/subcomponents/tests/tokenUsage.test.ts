import assert from 'node:assert/strict';
import test from 'node:test';

import { formatTokenCount, resolveTokenUsageDisplay } from '../tokenUsage';

test('resolveTokenUsageDisplay computes percent against the context window', () => {
  const result = resolveTokenUsageDisplay({ used: 158_500, contextLimit: 317_000 });
  assert.equal(result.usedTokens, 158_500);
  assert.equal(result.contextLimit, 317_000);
  assert.equal(result.percent, 50);
});

test('explicit `used` wins over the input/output sum', () => {
  const result = resolveTokenUsageDisplay({
    used: 200,
    inputTokens: 100,
    outputTokens: 50,
    contextLimit: 400,
  });
  assert.equal(result.usedTokens, 200);
  assert.equal(result.percent, 50);
});

test('used falls back to input+output (breakdown) when `used` is absent', () => {
  const result = resolveTokenUsageDisplay({ breakdown: { input: 100, output: 50 } });
  assert.equal(result.usedTokens, 150);
  assert.equal(result.contextLimit, null);
  assert.equal(result.percent, null);
});

test('percent is clamped to [0, 100]', () => {
  assert.equal(resolveTokenUsageDisplay({ used: 400_000, contextLimit: 317_000 }).percent, 100);
  assert.equal(resolveTokenUsageDisplay({ used: 0, contextLimit: 317_000 }).percent, 0);
});

test('a realistic 1M-context session reports a low percent', () => {
  // opus-4-8 = 1,000,000 max_input_tokens on the gateway; 236,329 used ≈ 24%.
  const result = resolveTokenUsageDisplay({ used: 236_329, contextLimit: 1_000_000 });
  assert.equal(result.percent, 24);
});

test('a missing or non-positive context limit leaves percent null (raw-count fallback)', () => {
  assert.equal(resolveTokenUsageDisplay({ used: 100 }).percent, null);
  assert.equal(resolveTokenUsageDisplay({ used: 100, contextLimit: 0 }).percent, null);
  assert.equal(resolveTokenUsageDisplay({ used: 100, contextLimit: -5 }).percent, null);
});

test('null usage is handled without throwing', () => {
  const result = resolveTokenUsageDisplay(null);
  assert.equal(result.usedTokens, 0);
  assert.equal(result.percent, null);
  assert.equal(result.contextLimit, null);
});

test('formatTokenCount renders compact units', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(500), '500');
  assert.equal(formatTokenCount(1_500), '1.5K');
  assert.equal(formatTokenCount(34_000), '34K');
  assert.equal(formatTokenCount(1_500_000), '1.5M');
  assert.equal(formatTokenCount(12_000_000), '12M');
});
