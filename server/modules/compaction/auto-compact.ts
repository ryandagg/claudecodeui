/**
 * Replicates Claude Code's auto-compaction trigger threshold so the app can show
 * how close a session is to an automatic /compact — the number behind the
 * TokenUsageSummary button's percentage.
 *
 * WHY WE RECOMPUTE IT: the real trigger lives inside the Claude Code CLI (a
 * bun-compiled binary the Agent SDK spawns). It is never surfaced on the SDK
 * message stream, so the only way to display "% until auto-compact" is to
 * recompute the threshold from the same inputs the CLI reads.
 *
 * FORMULA (decoded from the CLI, claude 2.1.224 — functions DRo/uCe/S3e):
 *
 *   window          = CLAUDE_CODE_AUTO_COMPACT_WINDOW  (env, floored at 100_000)
 *                     ?? autoCompactWindow setting      (settings.json, floored at 100_000)
 *                     ?? model context limit (1M for [1m] models, else 200_000;
 *                        CLAUDE_CODE_MAX_CONTEXT_TOKENS overrides)
 *   outputReserve   = min(maxOutputTokens, 20_000)      // CLAUDE_CODE_MAX_OUTPUT_TOKENS feeds maxOutputTokens
 *   effectiveWindow = window - outputReserve
 *   threshold       = CLAUDE_AUTOCOMPACT_PCT_OVERRIDE in (0,100]
 *                       ? min( floor(effectiveWindow * pct/100), effectiveWindow - 13_000 )
 *                       : effectiveWindow - 13_000
 *   auto-compaction fires when the live context token count >= threshold.
 *
 * Note the CLI precedence: an explicit auto-compact window (env or setting)
 * WINS over the model's context limit — the model limit is only a fallback.
 *
 * The reserve constants below (100_000 floor, 20_000 output cap, 13_000
 * headroom) are CLI internals and can shift between CLI releases; re-verify
 * them against the pinned Claude Code version when bumping it.
 */

/** HRo — the floor the CLI applies to an explicit auto-compact window. */
const AUTO_COMPACT_WINDOW_FLOOR = 100_000;
/** F8u — the cap on the reserve held back for the model's response. */
const OUTPUT_RESERVE_CAP = 20_000;
/** The fixed headroom subtracted below the effective window (CLI's `e - 13000`). */
const COMPACT_HEADROOM = 13_000;
/** Fallback context window for a model with no `[1m]` marker. */
const DEFAULT_MODEL_CONTEXT_LIMIT = 200_000;
/** Context window for `[1m]`-tagged models (opus[1m], sonnet[1m], …). */
const ONE_M_CONTEXT_LIMIT = 1_000_000;
/**
 * Fallback max-output-tokens when the model default is unknown. Any Claude value
 * is >= OUTPUT_RESERVE_CAP, so the reserve resolves to 20_000 regardless — this
 * only matters if CLAUDE_CODE_MAX_OUTPUT_TOKENS is set below 20_000.
 */
const DEFAULT_MODEL_MAX_OUTPUT = 32_000;

export interface AutoCompactInputs {
  /** CLAUDE_CODE_AUTO_COMPACT_WINDOW (parsed) or null. Wins over everything below. */
  windowEnv?: number | null;
  /** `autoCompactWindow` settings.json key (parsed) or null. */
  windowSetting?: number | null;
  /** Resolved model context limit — the fallback window when both above are unset. */
  modelContextLimit: number;
  /** Resolved max output tokens (CLAUDE_CODE_MAX_OUTPUT_TOKENS or the model default). */
  maxOutputTokens: number;
  /** CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (parsed float) or null; applied only when 0 < pct <= 100. */
  pctOverride?: number | null;
}

export interface AutoCompactThreshold {
  /** Token count at which auto-compaction triggers, or null when inputs are unusable. */
  threshold: number | null;
  /** Resolved context window before reserves (for the tooltip). */
  window: number | null;
  /** window - outputReserve. */
  effectiveWindow: number | null;
  /** Where `window` came from. */
  source: 'env' | 'setting' | 'model';
}

const isPositiveFinite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Parses a token-count env/setting string (`parseInt`, base 10). Returns a
 * positive integer or null (empty, non-numeric, or <= 0 all become null).
 */
export function parseTokenCount(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Parses CLAUDE_AUTOCOMPACT_PCT_OVERRIDE the way the CLI does: `parseFloat`,
 * valid only when 0 < pct <= 100. Anything else (including "0" and "150")
 * yields null, i.e. "no override — use the default headroom threshold".
 */
export function parsePercentOverride(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const parsed = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : null;
}

/**
 * Resolves the model's context window for the fallback path (used only when no
 * explicit auto-compact window is configured). `[1m]`-tagged models get 1M;
 * everything else gets the 200K default. CLAUDE_CODE_MAX_CONTEXT_TOKENS, when
 * set, overrides both — matching the CLI's own override.
 */
export function resolveModelContextLimit(
  model: string | null | undefined,
  maxContextTokensEnv?: number | null,
): number {
  if (isPositiveFinite(maxContextTokensEnv)) return maxContextTokensEnv;
  return /\[1m\]/i.test(model ?? '') ? ONE_M_CONTEXT_LIMIT : DEFAULT_MODEL_CONTEXT_LIMIT;
}

/**
 * Computes the auto-compaction trigger threshold from already-resolved inputs.
 * Pure — all I/O (settings.json, process.env, model resolution) happens in the
 * caller so this stays trivially testable.
 */
export function resolveAutoCompactThreshold(inputs: AutoCompactInputs): AutoCompactThreshold {
  const { windowEnv, windowSetting, modelContextLimit, maxOutputTokens, pctOverride } = inputs;

  let window: number;
  let source: AutoCompactThreshold['source'];
  if (isPositiveFinite(windowEnv)) {
    window = Math.max(AUTO_COMPACT_WINDOW_FLOOR, windowEnv);
    source = 'env';
  } else if (isPositiveFinite(windowSetting)) {
    window = Math.max(AUTO_COMPACT_WINDOW_FLOOR, windowSetting);
    source = 'setting';
  } else if (isPositiveFinite(modelContextLimit)) {
    window = modelContextLimit;
    source = 'model';
  } else {
    return { threshold: null, window: null, effectiveWindow: null, source: 'model' };
  }

  const resolvedMaxOutput = isPositiveFinite(maxOutputTokens) ? maxOutputTokens : DEFAULT_MODEL_MAX_OUTPUT;
  const outputReserve = Math.min(resolvedMaxOutput, OUTPUT_RESERVE_CAP);
  const effectiveWindow = window - outputReserve;
  if (!(effectiveWindow > 0)) {
    return { threshold: null, window, effectiveWindow: null, source };
  }

  const headroomThreshold = effectiveWindow - COMPACT_HEADROOM;
  const threshold = isPositiveFinite(pctOverride) && pctOverride <= 100
    ? Math.min(Math.floor(effectiveWindow * (pctOverride / 100)), headroomThreshold)
    : headroomThreshold;

  if (!(threshold > 0)) {
    return { threshold: null, window, effectiveWindow, source };
  }
  return { threshold, window, effectiveWindow, source };
}
