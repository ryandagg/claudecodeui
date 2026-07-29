import assert from 'node:assert/strict';
import test from 'node:test';

import { formatTimeAgo } from './dateUtils';

// The i18n `t` is injected; passing a passthrough key-echoing stub keeps these
// assertions deterministic and independent of translation catalogs. `currentTime`
// is injected too, so no wall-clock dependency.
const t = ((key: string, opts?: { count?: number }) =>
  opts && typeof opts.count === 'number' ? `${key}:${opts.count}` : key) as never;

const NOW = new Date('2026-01-15T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('formatTimeAgo returns the unknown key for an invalid date', () => {
  assert.equal(formatTimeAgo('not-a-date', NOW, t), 'status.unknown');
});

test('formatTimeAgo reports just-now under a minute', () => {
  assert.equal(formatTimeAgo(ago(30 * SEC), NOW, t), 'time.justNow');
});

test('formatTimeAgo distinguishes singular and plural minutes', () => {
  assert.equal(formatTimeAgo(ago(MIN), NOW, t), 'time.oneMinuteAgo');
  assert.equal(formatTimeAgo(ago(5 * MIN), NOW, t), 'time.minutesAgo:5');
});

test('formatTimeAgo distinguishes singular and plural hours', () => {
  assert.equal(formatTimeAgo(ago(HOUR), NOW, t), 'time.oneHourAgo');
  assert.equal(formatTimeAgo(ago(5 * HOUR), NOW, t), 'time.hoursAgo:5');
});

test('formatTimeAgo distinguishes singular and plural days within a week', () => {
  assert.equal(formatTimeAgo(ago(DAY), NOW, t), 'time.oneDayAgo');
  assert.equal(formatTimeAgo(ago(3 * DAY), NOW, t), 'time.daysAgo:3');
});

test('formatTimeAgo falls back to a locale date past a week', () => {
  const result = formatTimeAgo(ago(30 * DAY), NOW, t);
  // Not one of the relative-time keys → a formatted date string.
  assert.equal(result.startsWith('time.'), false);
  assert.equal(result.startsWith('status.'), false);
  assert.ok(result.length > 0);
});
