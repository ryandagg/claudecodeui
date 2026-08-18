/**
 * Token-budget extraction from Claude SDK stream messages.
 *
 * Pulled out of `claude-sdk.js` so this pure usage-parsing logic can be unit
 * tested without importing the SDK and provider services that module loads.
 *
 * The run loop calls this on every stream message and relays the result to the
 * client as a `token_budget` update (which the "% until auto-compaction" button
 * renders). A turn produces several frames: the assistant frame carries the real
 * usage (input + output + cache), while the terminal `result` frame carries an
 * empty/zero usage object. Returning `used: 0` from that empty frame would
 * clobber the assistant frame's real reading — on both the live send and the
 * deferred auto-compact re-emit (which re-sends the last budget) — so a
 * zero/empty usage object is treated as "no data" (null) and the last real
 * reading stands.
 */

export interface TokenBudget {
  /** Total tokens occupying the context (input + output + cache). */
  used: number;
  /** Legacy context-window hint (CONTEXT_WINDOW env, else 160000). */
  total: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheTokens?: number;
  breakdown: { input: number; output: number };
}

type UnknownRecord = Record<string, unknown>;

function readNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Legacy `total` field: the raw context window, overridable via env. */
function contextWindow(): number {
  return parseInt(process.env.CONTEXT_WINDOW ?? '', 10) || 160000;
}

/**
 * Extracts token usage from an SDK stream message.
 *
 * Prefers the per-step `message.usage` (Claude message payload), then falls back
 * to result-level `modelUsage` for compatibility across SDK versions. Returns
 * `null` when the message carries no usable usage — including an empty/all-zero
 * usage object — so callers keep their last real reading instead of showing 0.
 */
export function extractTokenBudget(sdkMessage: unknown): TokenBudget | null {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  const message = sdkMessage as UnknownRecord;
  const nestedUsage = (message.message as UnknownRecord | undefined)?.usage;
  const messageUsage = (nestedUsage ?? message.usage) as UnknownRecord | undefined;

  if (messageUsage && typeof messageUsage === 'object') {
    const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
    const cacheCreationTokens = readNumber(
      messageUsage.cache_creation_input_tokens ??
        messageUsage.cacheCreationInputTokens ??
        messageUsage.cacheCreationTokens,
    );
    const cacheReadTokens = readNumber(
      messageUsage.cache_read_input_tokens ??
        messageUsage.cacheReadInputTokens ??
        messageUsage.cacheReadTokens,
    );
    const cacheTokens = cacheCreationTokens + cacheReadTokens;
    const inputTokens = directInputTokens + cacheTokens;
    const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
    const totalUsed = inputTokens + outputTokens;

    // Empty/all-zero usage object (e.g. the terminal `result` frame): no data.
    // Skip it so it can't overwrite the real reading from the assistant frame.
    if (totalUsed <= 0) {
      return null;
    }

    return {
      used: totalUsed,
      total: contextWindow(),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cacheTokens,
      breakdown: { input: inputTokens, output: outputTokens },
    };
  }

  // Fallback for older SDK messages that only carry `modelUsage`.
  const modelUsage = message.modelUsage as UnknownRecord | undefined;
  if (!modelUsage || typeof modelUsage !== 'object') {
    return null;
  }

  const modelKey = Object.keys(modelUsage)[0];
  if (!modelKey) {
    return null;
  }
  const modelData = modelUsage[modelKey] as UnknownRecord | undefined;
  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  if (totalUsed <= 0) {
    return null;
  }

  return {
    used: totalUsed,
    total: contextWindow(),
    inputTokens,
    outputTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}
