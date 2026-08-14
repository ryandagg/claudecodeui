/**
 * Pure display helpers for the token-usage button. Kept free of React/JSX so the
 * percentage logic can be unit-tested without a DOM.
 *
 * The button prefers to show how much of the pre-auto-compaction budget is used
 * (`autoCompactThreshold`, computed server-side to match Claude Code's real
 * trigger). When no threshold is available — non-Claude providers, or before the
 * first budget update — it falls back to a formatted raw token count.
 */

export const readUsageNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Compact human-readable token count, e.g. 1.2K / 34K / 1.5M. */
export const formatTokenCount = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}K`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return value.toLocaleString();
};

export interface TokenUsageDisplay {
  /** Total tokens used (from `used`, else input+output). */
  usedTokens: number;
  /** The auto-compaction threshold in tokens, or null when unknown. */
  threshold: number | null;
  /** Percent of the pre-compaction budget used (0–100, clamped), or null when unknown. */
  percent: number | null;
}

/**
 * Derives what the button should show from a token-budget payload. Returns a
 * `percent` (relative to the auto-compaction threshold) when the server supplied
 * a positive threshold, otherwise leaves it null so the caller shows the raw count.
 */
export const resolveTokenUsageDisplay = (
  usage: Record<string, unknown> | null,
): TokenUsageDisplay => {
  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? (usage.breakdown as Record<string, unknown>)
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const usedTokens = readUsageNumber(usage?.used) || inputTokens + outputTokens;

  const thresholdRaw = readUsageNumber(usage?.autoCompactThreshold);
  const threshold = thresholdRaw > 0 ? thresholdRaw : null;
  const percent =
    threshold !== null
      ? Math.min(100, Math.max(0, Math.round((usedTokens / threshold) * 100)))
      : null;

  return { usedTokens, threshold, percent };
};
