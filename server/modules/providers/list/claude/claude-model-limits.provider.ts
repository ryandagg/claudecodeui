import { exec } from 'node:child_process';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { rootCertificates } from 'node:tls';
import { promisify } from 'node:util';

import { readClaudeApiKeyHelper, readClaudeSettingsEnvValue } from './claude-settings.provider.js';

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
 * Auth reuses the same `apiKeyHelper` the Claude CLI runs to mint a gateway key.
 * The gateway base URL and its TLS trust bundle come from Claude's settings.json
 * `env` (`ANTHROPIC_BASE_URL`, `NODE_EXTRA_CA_CERTS`) first, falling back to the
 * process env: the CLI applies settings.json `env` over the shell, and a server
 * started from a plain shell won't have these in its own environment at all. The
 * request uses `node:https` (not the global `fetch`) so it can present that CA,
 * which Node otherwise only loads from `NODE_EXTRA_CA_CERTS` at process startup.
 * Nothing is hardcoded, and a setup without a gateway falls back to a raw count.
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

/**
 * Prefers a value from Claude's settings.json `env` over the process environment
 * (see `readClaudeSettingsEnvValue`). Trims both; returns null when neither has a
 * non-empty value. Used for the gateway base URL and the extra-CA path.
 */
export function preferSettingsValue(
  settingsValue: string | null | undefined,
  envValue: string | null | undefined,
): string | null {
  const fromSettings = typeof settingsValue === 'string' ? settingsValue.trim() : '';
  if (fromSettings) {
    return fromSettings;
  }
  const fromEnv = typeof envValue === 'string' ? envValue.trim() : '';
  return fromEnv || null;
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

/**
 * Builds the additive CA list for the gateway request: Node's default roots plus
 * the extra bundle at `NODE_EXTRA_CA_CERTS` (settings.json first, then the process
 * env). This mirrors how `NODE_EXTRA_CA_CERTS` augments — rather than replaces —
 * the trust store, which Node only reads at startup. Returns undefined (Node's
 * defaults) when no bundle is configured or it can't be read.
 */
function resolveCaBundle(settingsCaPath: string | null): string[] | undefined {
  const caPath = preferSettingsValue(settingsCaPath, process.env.NODE_EXTRA_CA_CERTS);
  if (!caPath) {
    return undefined;
  }
  try {
    return [...rootCertificates, readFileSync(caPath, 'utf8')];
  } catch {
    return undefined;
  }
}

/**
 * One-shot HTTPS GET returning parsed JSON, or null on any non-2xx, timeout,
 * transport, or parse error (the caller treats null as "no catalog"). Uses
 * `node:https` rather than the global `fetch` so it can present a custom CA.
 */
function fetchJsonOverHttps(
  url: string,
  { key, ca, timeoutMs }: { key: string; ca: string[] | undefined; timeoutMs: number },
): Promise<unknown> {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { headers: { Authorization: `Bearer ${key}` }, ca, agent: false },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          resolve(null);
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
  });
}

async function fetchModelLimits(): Promise<Record<string, number> | null> {
  const baseUrl = preferSettingsValue(
    await readClaudeSettingsEnvValue('ANTHROPIC_BASE_URL'),
    process.env.ANTHROPIC_BASE_URL,
  );
  if (!baseUrl) {
    return null; // no gateway configured: caller falls back to a raw token count
  }
  const key = await mintGatewayKey();
  if (!key) {
    return null;
  }

  const ca = resolveCaBundle(await readClaudeSettingsEnvValue('NODE_EXTRA_CA_CERTS'));
  const body = await fetchJsonOverHttps(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
    key,
    ca,
    timeoutMs: 20_000,
  });
  if (!body) {
    return null;
  }
  const limits = parseModelLimits(body);
  return Object.keys(limits).length > 0 ? limits : null;
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
