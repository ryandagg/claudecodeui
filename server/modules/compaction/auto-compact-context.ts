/**
 * Gathers the live inputs Claude Code's auto-compaction threshold depends on and
 * runs them through the pure formula in ./auto-compact.ts.
 *
 * Inputs come from the same places the CLI reads them, in the CLI's precedence:
 * the auto-compact window env var, then the settings.json `autoCompactWindow`
 * key, then the model's context limit. For the env var itself, the settings.json
 * `env` layer WINS over the inherited shell env — the spawned CLI does
 * `Object.assign(process.env, <scope>.env)` for each active settings scope, so a
 * settings value overwrites whatever the shell exported (verified against the
 * CLI's own `/context`; see readEnv below). Reading `~/.claude/settings.json`
 * keeps the app on the single source of truth rather than mirroring Claude config.
 *
 * The result is static for a run (window/pct/reserves/model are all fixed), so
 * the caller resolves it once and stamps it onto every token-budget update.
 */

import { readClaudeAutoCompactConfig } from '@/modules/providers/index.js';

import {
  parsePercentOverride,
  parseTokenCount,
  resolveAutoCompactThreshold,
  resolveModelContextLimit,
} from './auto-compact.js';

export interface AutoCompactContext {
  /** Token count at which auto-compaction triggers, or null when it can't be resolved. */
  autoCompactThreshold: number | null;
  /** The resolved context window before reserves (for the tooltip), or null. */
  contextWindow: number | null;
}

const EMPTY_CONTEXT: AutoCompactContext = { autoCompactThreshold: null, contextWindow: null };

/**
 * Resolves the auto-compaction threshold for a run.
 *
 * @param runModel the model resolved for this run (may be the `default`
 *   sentinel or null, in which case the settings.json default model is used to
 *   detect a `[1m]` context window).
 */
export async function resolveAutoCompactContext(
  runModel: string | null | undefined,
): Promise<AutoCompactContext> {
  try {
    const config = await readClaudeAutoCompactConfig();

    // settings.json `env` wins over the inherited shell env, then process.env is
    // the fallback for keys settings.json doesn't define. This matches the CLI:
    // it applies each active settings scope's env with Object.assign(process.env,
    // scope.env) AFTER inheriting the shell, so settings overwrites the shell.
    // Verified empirically — with shell CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000 but
    // settings.json env=3, the CLI's `/context` reports a 100k window (3 floored to
    // the 100k minimum), i.e. the settings value, not the shell export.
    //
    // On a machine where neither layer defines these keys (e.g. a personal box
    // with no such exports), every read below is undefined; parseTokenCount /
    // parsePercentOverride map that to null, and resolveAutoCompactThreshold falls
    // back to the model context limit — no NaN, no throw.
    const readEnv = (key: string): string | undefined => config.env[key] ?? process.env[key];

    const windowEnv = parseTokenCount(readEnv('CLAUDE_CODE_AUTO_COMPACT_WINDOW'));
    const pctOverride = parsePercentOverride(readEnv('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'));
    const maxOutputTokens = parseTokenCount(readEnv('CLAUDE_CODE_MAX_OUTPUT_TOKENS')) ?? 0;
    const maxContextTokensEnv = parseTokenCount(readEnv('CLAUDE_CODE_MAX_CONTEXT_TOKENS'));

    // The run model is authoritative; fall back to the settings.json default only
    // when the run didn't pin a concrete model (the `default` sentinel or null).
    const effectiveModel = runModel && runModel !== 'default' ? runModel : config.model;
    const modelContextLimit = resolveModelContextLimit(effectiveModel, maxContextTokensEnv);

    const { threshold, window } = resolveAutoCompactThreshold({
      windowEnv,
      windowSetting: config.autoCompactWindow,
      modelContextLimit,
      maxOutputTokens,
      pctOverride,
    });

    return { autoCompactThreshold: threshold, contextWindow: window };
  } catch {
    // Any failure — a malformed settings.json, an unexpected config shape, or an
    // arithmetic edge — must never break a live run's budget updates. Degrade to
    // "no threshold" so the button falls back to a raw token count.
    return EMPTY_CONTEXT;
  }
}
