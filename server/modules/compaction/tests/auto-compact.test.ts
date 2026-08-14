import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parsePercentOverride,
  parseTokenCount,
  resolveAutoCompactThreshold,
  resolveModelContextLimit,
} from '@/modules/compaction/auto-compact.js';

test('parseTokenCount accepts positive ints and rejects the rest', () => {
  assert.equal(parseTokenCount('350000'), 350000);
  assert.equal(parseTokenCount(350000), 350000);
  assert.equal(parseTokenCount('0'), null);
  assert.equal(parseTokenCount('-5'), null);
  assert.equal(parseTokenCount(''), null);
  assert.equal(parseTokenCount('abc'), null);
  assert.equal(parseTokenCount(null), null);
  assert.equal(parseTokenCount(undefined), null);
});

test('parsePercentOverride mirrors the CLI: parseFloat, valid only in (0,100]', () => {
  assert.equal(parsePercentOverride('99'), 99);
  assert.equal(parsePercentOverride('99.5'), 99.5);
  assert.equal(parsePercentOverride('100'), 100);
  assert.equal(parsePercentOverride('0'), null);
  assert.equal(parsePercentOverride('150'), null);
  assert.equal(parsePercentOverride('abc'), null);
  assert.equal(parsePercentOverride(null), null);
});

test('resolveModelContextLimit: [1m] models get 1M, others 200K, env overrides both', () => {
  assert.equal(resolveModelContextLimit('us.anthropic.claude-opus-4-8[1m]'), 1_000_000);
  assert.equal(resolveModelContextLimit('opus[1m]'), 1_000_000);
  assert.equal(resolveModelContextLimit('opus'), 200_000);
  assert.equal(resolveModelContextLimit(null), 200_000);
  assert.equal(resolveModelContextLimit('opus[1m]', 500_000), 500_000);
  assert.equal(resolveModelContextLimit('opus', 500_000), 500_000);
});

test("real config (window=350K env, pct=99): threshold is capped by the 13K headroom", () => {
  // effectiveWindow = 350000 - min(32000,20000) = 330000
  // pct: floor(330000 * 0.99) = 326700; headroom: 330000 - 13000 = 317000; min = 317000
  const result = resolveAutoCompactThreshold({
    windowEnv: 350_000,
    modelContextLimit: 1_000_000,
    maxOutputTokens: 32_000,
    pctOverride: 99,
  });
  assert.equal(result.threshold, 317_000);
  assert.equal(result.window, 350_000);
  assert.equal(result.effectiveWindow, 330_000);
  assert.equal(result.source, 'env');
});

test('percentage override binds when it lands below the headroom threshold', () => {
  // effectiveWindow = 330000; floor(330000 * 0.90) = 297000 < 317000 headroom
  const result = resolveAutoCompactThreshold({
    windowEnv: 350_000,
    modelContextLimit: 1_000_000,
    maxOutputTokens: 32_000,
    pctOverride: 90,
  });
  assert.equal(result.threshold, 297_000);
});

test('pct=100 collapses to the headroom threshold (never above window-13K)', () => {
  const result = resolveAutoCompactThreshold({
    windowEnv: 350_000,
    modelContextLimit: 1_000_000,
    maxOutputTokens: 32_000,
    pctOverride: 100,
  });
  assert.equal(result.threshold, 317_000); // min(floor(330000), 317000)
});

test('no pct override falls back to effectiveWindow minus 13K headroom', () => {
  const result = resolveAutoCompactThreshold({
    windowEnv: 350_000,
    modelContextLimit: 1_000_000,
    maxOutputTokens: 32_000,
    pctOverride: null,
  });
  assert.equal(result.threshold, 317_000); // 330000 - 13000
});

test('explicit window is floored at 100K', () => {
  const result = resolveAutoCompactThreshold({
    windowEnv: 50_000,
    modelContextLimit: 1_000_000,
    maxOutputTokens: 32_000,
    pctOverride: null,
  });
  assert.equal(result.window, 100_000); // max(100000, 50000)
  assert.equal(result.threshold, 67_000); // (100000 - 20000) - 13000
});

test('output reserve below the 20K cap is used as-is', () => {
  const result = resolveAutoCompactThreshold({
    windowEnv: 350_000,
    modelContextLimit: 1_000_000,
    maxOutputTokens: 10_000, // min(10000, 20000) = 10000
    pctOverride: null,
  });
  assert.equal(result.effectiveWindow, 340_000);
  assert.equal(result.threshold, 327_000); // 340000 - 13000
});

test('window precedence: env > setting > model limit', () => {
  const env = resolveAutoCompactThreshold({
    windowEnv: 350_000,
    windowSetting: 250_000,
    modelContextLimit: 1_000_000,
    maxOutputTokens: 32_000,
  });
  assert.equal(env.source, 'env');
  assert.equal(env.window, 350_000);

  const setting = resolveAutoCompactThreshold({
    windowSetting: 250_000,
    modelContextLimit: 1_000_000,
    maxOutputTokens: 32_000,
  });
  assert.equal(setting.source, 'setting');
  assert.equal(setting.window, 250_000);

  const model = resolveAutoCompactThreshold({
    modelContextLimit: 1_000_000,
    maxOutputTokens: 32_000,
  });
  assert.equal(model.source, 'model');
  assert.equal(model.window, 1_000_000);
  assert.equal(model.threshold, 967_000); // (1000000 - 20000) - 13000
});

test('unusable inputs yield a null threshold rather than a bogus number', () => {
  const noWindow = resolveAutoCompactThreshold({
    modelContextLimit: 0,
    maxOutputTokens: 32_000,
  });
  assert.equal(noWindow.threshold, null);
  assert.equal(noWindow.window, null);

  // A window smaller than the reserves collapses to a non-positive threshold.
  const tinyWindow = resolveAutoCompactThreshold({
    windowSetting: null,
    windowEnv: null,
    modelContextLimit: 25_000, // 25000 - 20000 = 5000 effective; 5000 - 13000 < 0
    maxOutputTokens: 32_000,
  });
  assert.equal(tinyWindow.threshold, null);
});

test('personal machine with nothing configured falls back to the model context limit', () => {
  // No CLAUDE_CODE_* exports and no autoCompactWindow/pct: every env-derived
  // input is null and maxOutputTokens is 0 (unset). The threshold must still
  // resolve from the model limit without NaN or a throw.
  const unrecognized = resolveAutoCompactThreshold({
    windowEnv: null,
    windowSetting: null,
    modelContextLimit: 200_000, // resolveModelContextLimit(null) default
    maxOutputTokens: 0,
    pctOverride: null,
  });
  assert.equal(unrecognized.source, 'model');
  assert.equal(unrecognized.window, 200_000);
  // maxOutputTokens 0 (unset) still reserves the 20K cap, not 0.
  assert.equal(unrecognized.effectiveWindow, 180_000);
  assert.equal(unrecognized.threshold, 167_000); // (200000 - 20000) - 13000

  const oneMillion = resolveAutoCompactThreshold({
    windowEnv: null,
    windowSetting: null,
    modelContextLimit: 1_000_000, // a [1m] model with nothing else set
    maxOutputTokens: 0,
    pctOverride: null,
  });
  assert.equal(oneMillion.threshold, 967_000); // (1000000 - 20000) - 13000
});
