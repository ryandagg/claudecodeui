/**
 * Pure display helpers for the token-usage button. Kept free of React/JSX so the
 * percentage logic can be unit-tested without a DOM.
 *
 * The button prefers to show how full the model's context window is
 * (`contextLimit` = the model's `max_input_tokens` from the gateway catalog,
 * relayed on the token-budget stream). When no limit is available — a non-Claude
 * provider, an unlisted model, or before the context-limit cache has loaded — it
 * falls back to a formatted raw token count.
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
  /** The model's context window in tokens, or null when unknown. */
  contextLimit: number | null;
  /** Percent of the context window used (0–100, clamped), or null when unknown. */
  percent: number | null;
}

/**
 * Derives what the button should show from a token-budget payload. Returns a
 * `percent` (relative to the model's context window) when the server supplied a
 * positive `contextLimit`, otherwise leaves it null so the caller shows the raw count.
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

  const contextLimitRaw = readUsageNumber(usage?.contextLimit);
  const contextLimit = contextLimitRaw > 0 ? contextLimitRaw : null;
  const percent =
    contextLimit !== null
      ? Math.min(100, Math.max(0, Math.round((usedTokens / contextLimit) * 100)))
      : null;

  return { usedTokens, contextLimit, percent };
};
