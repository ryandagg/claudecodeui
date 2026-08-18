/**
 * Pure display helpers for the token-usage button. Kept free of React/JSX so the
 * percentage logic can be unit-tested without a DOM.
 *
 * The button prefers to show how much of the pre-auto-compaction budget is used
 * (`autoCompactThreshold`, reported by the Claude Code CLI via the SDK's
 * getContextUsage() and relayed on the token-budget stream). When no threshold is
 * available — non-Claude providers, or before the first budget update of a run
 * (e.g. right after opening a session) — it falls back to a formatted raw count.
 */

export const readUsageNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Merges a stable auto-compaction threshold across token-budget updates.
 *
 * The threshold depends on the model + env, not the conversation, so it's a
 * stable per-session property — but not every update carries it. A live run
 * stamps it once the CLI reports it; a REST load/refetch only includes it on a
 * warm cache. Without stickiness, a threshold-less update (e.g. a post-turn REST
 * refetch whose cache key hasn't warmed) would drop the button from "%" back to
 * a raw count. This remembers the last positive threshold so the display only
 * upgrades to "%", never regresses — while a fresh positive threshold (e.g. after
 * a mid-session model change) still replaces the remembered one.
 *
 * @param incoming the new budget (or null to reset, e.g. on session change)
 * @param remembered the last positive threshold seen this session, or null
 * @returns the budget to store and the threshold to remember next
 */
export const mergeStickyThreshold = (
  incoming: Record<string, unknown> | null,
  remembered: number | null,
): { budget: Record<string, unknown> | null; remembered: number | null } => {
  if (incoming === null) {
    return { budget: null, remembered: null };
  }
  const incomingThreshold = readUsageNumber(incoming.autoCompactThreshold);
  if (incomingThreshold > 0) {
    return { budget: incoming, remembered: incomingThreshold };
  }
  if (remembered && remembered > 0) {
    return { budget: { ...incoming, autoCompactThreshold: remembered }, remembered };
  }
  return { budget: incoming, remembered };
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
