import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProviderModelsService, PROVIDER_MODELS_CACHE_TTL_MS } from '@/modules/providers/services/provider-models.service.js';
import type {
  LLMProvider,
  ProviderChangeActiveModelInput,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import { writeProviderSessionActiveModelChange } from '@/shared/utils.js';

const MODELS = {
  OPTIONS: [
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus' },
  ],
  DEFAULT: 'sonnet',
};

// A cached (non-claude) provider key exercises the on-disk/in-memory cache path;
// claude is deliberately in the UNCACHED set. The registry type is claude-only,
// so cast where a synthetic provider name is needed.
const CACHED_PROVIDER = 'test-cached' as LLMProvider;

const makeFakeProvider = (overrides: Record<string, unknown> = {}) => {
  const calls = { getSupportedModels: 0, getCurrentActiveModel: 0, changeActiveModel: 0 };
  const models = {
    async getSupportedModels() {
      calls.getSupportedModels += 1;
      return MODELS;
    },
    async getCurrentActiveModel(sessionId?: string) {
      calls.getCurrentActiveModel += 1;
      return { model: 'sonnet', sessionId };
    },
    async changeActiveModel(input: ProviderChangeActiveModelInput): Promise<ProviderSessionActiveModelChange> {
      calls.changeActiveModel += 1;
      return {
        provider: 'claude',
        sessionId: input.sessionId,
        changed: true,
        supported: true,
        model: 'opus',
      };
    },
    ...overrides,
  };
  return { calls, provider: { models } };
};

const makeTempCachePath = async (label: string) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `cg-models-${label}-`));
  return { dir, cachePath: path.join(dir, 'cache.json') };
};

// ---------------------------------------------------------------------------
// getProviderModels — claude (uncached) path
// ---------------------------------------------------------------------------
// Claude overrides the shared TTL with a shorter window (see
// PROVIDER_MODELS_CACHE_TTL_OVERRIDES_MS in the service) so a profile /
// entitlement change surfaces without a hard refresh. The override map is not
// exported, so mirror its value here.
const CLAUDE_CACHE_TTL_MS = 10 * 60 * 1000;

test('getProviderModels loads claude fresh and persists it under the shorter claude TTL', async () => {
  const { dir, cachePath } = await makeTempCachePath('claude');
  try {
    const fake = makeFakeProvider();
    const nowMs = 1_000;
    const service = createProviderModelsService({
      resolveProvider: () => fake.provider,
      cachePath,
      now: () => nowMs,
    });

    const result = await service.getProviderModels('claude');
    assert.deepEqual(result.models, MODELS);
    assert.equal(result.cache.source, 'fresh');
    // Claude carries a real TTL window, and it is shorter than the shared default.
    const windowMs = new Date(result.cache.expiresAt).getTime() - new Date(result.cache.updatedAt).getTime();
    assert.equal(windowMs, CLAUDE_CACHE_TTL_MS);
    assert.ok(CLAUDE_CACHE_TTL_MS < PROVIDER_MODELS_CACHE_TTL_MS);

    // Claude now persists to disk like any cached provider (raw entry stores ms).
    const persisted = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    assert.equal(persisted.entries.claude.expiresAt, nowMs + CLAUDE_CACHE_TTL_MS);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('getProviderModels dedupes concurrent claude requests into one provider call', async () => {
  const { dir, cachePath } = await makeTempCachePath('dedupe');
  try {
    const fake = makeFakeProvider();
    const service = createProviderModelsService({
      resolveProvider: () => fake.provider,
      cachePath,
      now: () => 1_000,
    });

    const [a, b] = await Promise.all([
      service.getProviderModels('claude'),
      service.getProviderModels('claude'),
    ]);
    assert.deepEqual(a.models, MODELS);
    assert.deepEqual(b.models, MODELS);
    assert.equal(fake.calls.getSupportedModels, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// getProviderModels — cached provider path (memory + disk + bypass)
// ---------------------------------------------------------------------------
test('getProviderModels caches a cacheable provider in memory and on disk', async () => {
  const { dir, cachePath } = await makeTempCachePath('cached');
  try {
    const fake = makeFakeProvider();
    const service = createProviderModelsService({
      resolveProvider: () => fake.provider,
      cachePath,
      now: () => 5_000,
    });

    const first = await service.getProviderModels(CACHED_PROVIDER);
    assert.equal(first.cache.source, 'fresh');
    assert.equal(fake.calls.getSupportedModels, 1);

    // Cache file written with a TTL window in the future.
    const persisted = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    assert.equal(persisted.version, 1);
    assert.ok(persisted.entries[CACHED_PROVIDER]);
    assert.equal(persisted.entries[CACHED_PROVIDER].expiresAt, 5_000 + PROVIDER_MODELS_CACHE_TTL_MS);

    // Second call is served from memory without another provider hit.
    const second = await service.getProviderModels(CACHED_PROVIDER);
    assert.equal(second.cache.source, 'memory');
    assert.equal(fake.calls.getSupportedModels, 1);

    // bypassCache forces a fresh provider call.
    const third = await service.getProviderModels(CACHED_PROVIDER, { bypassCache: true });
    assert.equal(third.cache.source, 'fresh');
    assert.equal(fake.calls.getSupportedModels, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('getProviderModels serves a cacheable provider from a pre-existing disk cache', async () => {
  const { dir, cachePath } = await makeTempCachePath('disk');
  try {
    const now = 10_000;
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        entries: {
          [CACHED_PROVIDER]: {
            updatedAt: now - 1_000,
            expiresAt: now + PROVIDER_MODELS_CACHE_TTL_MS,
            models: MODELS,
          },
        },
      }),
      'utf8',
    );

    const fake = makeFakeProvider();
    const service = createProviderModelsService({
      resolveProvider: () => fake.provider,
      cachePath,
      now: () => now,
    });

    const result = await service.getProviderModels(CACHED_PROVIDER);
    assert.equal(result.cache.source, 'disk');
    assert.deepEqual(result.models, MODELS);
    // Served from disk — provider was never queried.
    assert.equal(fake.calls.getSupportedModels, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('getProviderModels ignores an expired disk cache entry and reloads', async () => {
  const { dir, cachePath } = await makeTempCachePath('expired');
  try {
    const now = 100_000;
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        entries: {
          [CACHED_PROVIDER]: {
            updatedAt: now - PROVIDER_MODELS_CACHE_TTL_MS,
            expiresAt: now - 1, // already expired
            models: MODELS,
          },
        },
      }),
      'utf8',
    );

    const fake = makeFakeProvider();
    const service = createProviderModelsService({
      resolveProvider: () => fake.provider,
      cachePath,
      now: () => now,
    });

    const result = await service.getProviderModels(CACHED_PROVIDER);
    assert.equal(result.cache.source, 'fresh');
    assert.equal(fake.calls.getSupportedModels, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('clearCache drops in-memory state so the next lookup re-reads from disk', async () => {
  const { dir, cachePath } = await makeTempCachePath('clear');
  try {
    const fake = makeFakeProvider();
    const service = createProviderModelsService({
      resolveProvider: () => fake.provider,
      cachePath,
      now: () => 1,
    });

    const first = await service.getProviderModels(CACHED_PROVIDER);
    assert.equal(first.cache.source, 'fresh');
    assert.equal(fake.calls.getSupportedModels, 1);

    service.clearCache();

    // Memory is cleared, but the still-valid disk cache is reloaded rather than
    // re-fetching from the provider.
    const second = await service.getProviderModels(CACHED_PROVIDER);
    assert.equal(second.cache.source, 'disk');
    assert.equal(fake.calls.getSupportedModels, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resolveResumeModel
// ---------------------------------------------------------------------------
test('resolveResumeModel returns the trimmed requested model when no session', async () => {
  const service = createProviderModelsService({ resolveProvider: () => makeFakeProvider().provider });
  assert.equal(await service.resolveResumeModel('claude', undefined, '  opus  '), 'opus');
  assert.equal(await service.resolveResumeModel('claude', '   ', ''), undefined);
});

test('resolveResumeModel prefers a supported changed session model over the request', async () => {
  const { dir, cachePath } = await makeTempCachePath('resume-changed');
  try {
    const activeModelChangesPath = path.join(dir, 'changes.json');
    // Seed through the real writer so the on-disk shape matches production.
    await writeProviderSessionActiveModelChange(
      'claude',
      { sessionId: 'sess-1', model: 'opus' },
      { filePath: activeModelChangesPath },
    );
    const service = createProviderModelsService({
      resolveProvider: () => makeFakeProvider().provider,
      cachePath,
      activeModelChangesPath,
    });

    assert.equal(await service.resolveResumeModel('claude', 'sess-1', 'sonnet'), 'opus');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resolveResumeModel falls back to the requested model when no session change exists', async () => {
  const { dir, cachePath } = await makeTempCachePath('resume-fallback');
  try {
    const activeModelChangesPath = path.join(dir, 'changes.json');
    const service = createProviderModelsService({
      resolveProvider: () => makeFakeProvider().provider,
      cachePath,
      activeModelChangesPath,
    });

    assert.equal(await service.resolveResumeModel('claude', 'sess-unknown', 'sonnet'), 'sonnet');
    assert.equal(await service.resolveResumeModel('claude', 'sess-unknown', '   '), undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// delegation: getCurrentActiveModel / changeActiveModel
// ---------------------------------------------------------------------------
test('getCurrentActiveModel and changeActiveModel delegate to the resolved provider', async () => {
  const fake = makeFakeProvider();
  const service = createProviderModelsService({ resolveProvider: () => fake.provider });

  const current = await service.getCurrentActiveModel('claude', 'sess-1');
  assert.deepEqual(current, { model: 'sonnet', sessionId: 'sess-1' });
  assert.equal(fake.calls.getCurrentActiveModel, 1);

  const changed = await service.changeActiveModel('claude', { sessionId: 'sess-1', model: 'opus' });
  assert.equal(changed.changed, true);
  assert.equal(fake.calls.changeActiveModel, 1);
});
