import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { readClaudeApiKeyHelper } from './claude-settings.provider.js';

/**
 * Per-model context-window limits, sourced from the model gateway's
 * OpenAI-compatible `/v1/models` endpoint (which reports `max_input_tokens` per
 * model). These power the token-usage button's "% of context window".
 *
 * WHY A LIVE ENDPOINT: the gateway is the single authority on each model's real
 * context window (opus-4-8 = 1,000,000 here), and it drifts as models change.
 * Every other source is wrong or goes stale — the CLI's built-in guess (the SDK's
 * getContextUsage reports a dropped-`[1m]` 200K for a resumed opus) and any
 * hand-maintained table (even the gateway team's own curated config lagged at
 * 364K). So the app fetches the catalog once at startup and caches it.
 *
 * Auth reuses the same `apiKeyHelper` the Claude CLI runs to mint a gateway key;
 * the base URL is `ANTHROPIC_BASE_URL`. Both are config, so nothing is hardcoded,
 * and a setup without them simply falls back to a raw token count.
 */

const execAsync = promisify(exec);

/**
 * Parses the gateway's `/v1/models` response into a `model id -> max_input_tokens`
 * map. Entries without a positive `max_input_tokens` are omitted (some gateway
 * models — e.g. certain `-vertex` variants — don't report one).
 */
export function parseModelLimits(body: unknown): Record<string, number> {
  const limits: Record<string, number> = {};
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    return limits;
  }
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const maxInput = Number(record.max_input_tokens);
    if (id && Number.isFinite(maxInput) && maxInput > 0) {
      limits[id] = maxInput;
    }
  }
  return limits;
}

/**
 * Resolves a model string to its context window using a limits map.
 *
 * The gateway ids are bare (`claude-opus-4-8`), while callers may pass a
 * Bedrock-flavored id (`us.anthropic.claude-opus-4-8[1m]`, `…-v1:0`) from a
 * session's JSONL, the app catalog, or an env default. This tries the raw value,
 * then progressively strips the provider prefix, the `[1m]` context-variant
 * marker, and a Bedrock version suffix, returning the first match.
 */
export function resolveContextLimit(
  limits: Record<string, number>,
  model: string | null | undefined,
): number | null {
  const raw = typeof model === 'string' ? model.trim() : '';
  if (!raw) {
    return null;
  }

  const base = raw.replace(/^(?:us|eu|apac)\.anthropic\./, '').replace(/^anthropic\./, '');
  const candidates = [
    raw,
    base,
    base.replace(/\[1m\]$/, ''),
    base.replace(/-v\d+:\d+$/, ''),
    base.replace(/\[1m\]$/, '').replace(/-v\d+:\d+$/, ''),
  ];
  for (const candidate of candidates) {
    const limit = limits[candidate];
    if (typeof limit === 'number' && limit > 0) {
      return limit;
    }
  }
  return null;
}

let limitsCache: Record<string, number> | null = null;
let inflight: Promise<void> | null = null;

/**
 * Runs the settings-file `apiKeyHelper` to mint a gateway key. This is the same
 * command the Claude CLI runs; the key is used only as a Bearer header below and
 * is never logged. Returns null when there is no helper configured.
 */
async function mintGatewayKey(): Promise<string | null> {
  const command = await readClaudeApiKeyHelper();
  if (!command) {
    return null;
  }
  try {
    const { stdout } = await execAsync(command, { timeout: 15_000 });
    const key = stdout.trim();
    return key || null;
  } catch {
    return null;
  }
}

async function fetchModelLimits(): Promise<Record<string, number> | null> {
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  if (!baseUrl) {
    return null; // no gateway configured: caller falls back to a raw token count
  }
  const key = await mintGatewayKey();
  if (!key) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const limits = parseModelLimits(await response.json());
    return Object.keys(limits).length > 0 ? limits : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Populates the context-limit cache from the gateway, deduped across concurrent
 * callers. Call once at server start; callers also invoke it (non-blocking) on a
 * later cache miss to self-heal. A failed fetch leaves the cache empty so the
 * next call retries; a restart re-fetches.
 */
export async function ensureModelContextLimits(force = false): Promise<void> {
  if (limitsCache && !force) {
    return;
  }
  if (inflight) {
    return inflight;
  }
  inflight = fetchModelLimits()
    .then((limits) => {
      if (limits) {
        limitsCache = limits;
      }
    })
    .catch(() => {
      // Leave the cache empty; the next caller retries.
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Synchronously returns a model's context window from the cache, or null if the
 * cache isn't populated yet or the model isn't listed. Never performs I/O, so
 * both the live run loop and the REST load path can stamp it without racing.
 */
export function peekModelContextLimit(model: string | null | undefined): number | null {
  return limitsCache ? resolveContextLimit(limitsCache, model) : null;
}
