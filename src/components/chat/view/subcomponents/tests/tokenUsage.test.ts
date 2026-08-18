import assert from 'node:assert/strict';
import test from 'node:test';

import { formatTokenCount, mergeStickyThreshold, resolveTokenUsageDisplay } from '../tokenUsage';

test('resolveTokenUsageDisplay computes percent against the auto-compact threshold', () => {
  const result = resolveTokenUsageDisplay({ used: 158_500, autoCompactThreshold: 317_000 });
  assert.equal(result.usedTokens, 158_500);
  assert.equal(result.threshold, 317_000);
  assert.equal(result.percent, 50);
});

test('explicit `used` wins over the input/output sum', () => {
  const result = resolveTokenUsageDisplay({
    used: 200,
    inputTokens: 100,
    outputTokens: 50,
    autoCompactThreshold: 400,
  });
  assert.equal(result.usedTokens, 200);
  assert.equal(result.percent, 50);
});

test('used falls back to input+output (breakdown) when `used` is absent', () => {
  const result = resolveTokenUsageDisplay({ breakdown: { input: 100, output: 50 } });
  assert.equal(result.usedTokens, 150);
  assert.equal(result.threshold, null);
  assert.equal(result.percent, null);
});

test('percent is clamped to [0, 100]', () => {
  assert.equal(resolveTokenUsageDisplay({ used: 400_000, autoCompactThreshold: 317_000 }).percent, 100);
  assert.equal(resolveTokenUsageDisplay({ used: 0, autoCompactThreshold: 317_000 }).percent, 0);
});

test('a missing or non-positive threshold leaves percent null (raw-count fallback)', () => {
  assert.equal(resolveTokenUsageDisplay({ used: 100 }).percent, null);
  assert.equal(resolveTokenUsageDisplay({ used: 100, autoCompactThreshold: 0 }).percent, null);
  assert.equal(resolveTokenUsageDisplay({ used: 100, autoCompactThreshold: -5 }).percent, null);
});

test('null usage is handled without throwing', () => {
  const result = resolveTokenUsageDisplay(null);
  assert.equal(result.usedTokens, 0);
  assert.equal(result.percent, null);
  assert.equal(result.threshold, null);
});

// ---------------------------------------------------------------------------
// mergeStickyThreshold — keep the auto-compact threshold across budget updates
// so the button never regresses from "%" to a raw count (the post-turn flicker).
// ---------------------------------------------------------------------------
test('mergeStickyThreshold remembers a positive threshold and passes the budget through', () => {
  const { budget, remembered } = mergeStickyThreshold({ used: 100, autoCompactThreshold: 167_000 }, null);
  assert.equal(remembered, 167_000);
  assert.deepEqual(budget, { used: 100, autoCompactThreshold: 167_000 });
});

test('mergeStickyThreshold backfills a threshold-less update with the remembered value', () => {
  // Reproduces the flicker: a live update sets 167k, then a REST refetch arrives
  // with a higher `used` but no threshold — it must still render "%".
  const first = mergeStickyThreshold({ used: 159_799, autoCompactThreshold: 167_000 }, null);
  const second = mergeStickyThreshold({ used: 167_381 }, first.remembered);
  assert.equal(second.remembered, 167_000);
  assert.deepEqual(second.budget, { used: 167_381, autoCompactThreshold: 167_000 });
  // And the display stays a percentage rather than dropping to a raw count.
  assert.equal(resolveTokenUsageDisplay(second.budget).percent, 100);
});

test('mergeStickyThreshold leaves a threshold-less update raw when none is remembered', () => {
  const { budget, remembered } = mergeStickyThreshold({ used: 156_318 }, null);
  assert.equal(remembered, null);
  assert.deepEqual(budget, { used: 156_318 });
  assert.equal(resolveTokenUsageDisplay(budget).percent, null);
});

test('mergeStickyThreshold lets a fresh positive threshold replace the remembered one', () => {
  const { budget, remembered } = mergeStickyThreshold({ used: 10, autoCompactThreshold: 92_000 }, 167_000);
  assert.equal(remembered, 92_000);
  assert.equal(budget?.autoCompactThreshold, 92_000);
});

test('mergeStickyThreshold resets remembered state on a null budget (session change)', () => {
  const { budget, remembered } = mergeStickyThreshold(null, 167_000);
  assert.equal(budget, null);
  assert.equal(remembered, null);
});

test('mergeStickyThreshold ignores a non-positive incoming threshold', () => {
  assert.equal(mergeStickyThreshold({ used: 5, autoCompactThreshold: 0 }, null).remembered, null);
  assert.equal(mergeStickyThreshold({ used: 5, autoCompactThreshold: -1 }, 167_000).budget?.autoCompactThreshold, 167_000);
});

test('formatTokenCount renders compact units', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(500), '500');
  assert.equal(formatTokenCount(1_500), '1.5K');
  assert.equal(formatTokenCount(34_000), '34K');
  assert.equal(formatTokenCount(1_500_000), '1.5M');
  assert.equal(formatTokenCount(12_000_000), '12M');
});
