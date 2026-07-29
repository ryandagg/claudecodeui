import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { AppError } from '@/shared/utils.js';

// The multi-provider surface (codex/opencode/gemini/cursor) was removed when the
// fork narrowed to Claude-only (commit da50006e). These tests exercise the
// remaining Claude MCP behavior plus the provider-agnostic global-add contract,
// which now iterates the live registry (Claude only).

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

const readJson = async (filePath: string): Promise<Record<string, unknown>> => {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content) as Record<string, unknown>;
};

/**
 * This test covers Claude MCP support for all scopes (user/local/project) and all transports (stdio/http/sse),
 * including add, update/list, and remove operations.
 */
test('providerMcpService handles claude MCP scopes/transports with file-backed persistence', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-claude-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-user-stdio',
      scope: 'user',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'my-server'],
      env: { API_KEY: 'secret' },
    });

    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-local-http',
      scope: 'local',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      workspacePath,
    });

    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-project-sse',
      scope: 'project',
      transport: 'sse',
      url: 'https://example.com/sse',
      headers: { 'X-API-Key': 'abc' },
      workspacePath,
    });

    const grouped = await providerMcpService.listProviderMcpServers('claude', { workspacePath });
    assert.ok(grouped.user.some((server) => server.name === 'claude-user-stdio' && server.transport === 'stdio'));
    assert.ok(grouped.local.some((server) => server.name === 'claude-local-http' && server.transport === 'http'));
    assert.ok(grouped.project.some((server) => server.name === 'claude-project-sse' && server.transport === 'sse'));

    // update behavior is the same upsert route with same name
    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-project-sse',
      scope: 'project',
      transport: 'sse',
      url: 'https://example.com/sse-updated',
      headers: { 'X-API-Key': 'updated' },
      workspacePath,
    });

    const projectConfig = await readJson(path.join(workspacePath, '.mcp.json'));
    const projectServers = projectConfig.mcpServers as Record<string, unknown>;
    const projectServer = projectServers['claude-project-sse'] as Record<string, unknown>;
    assert.equal(projectServer.url, 'https://example.com/sse-updated');

    const removeResult = await providerMcpService.removeProviderMcpServer('claude', {
      name: 'claude-local-http',
      scope: 'local',
      workspacePath,
    });
    assert.equal(removeResult.removed, true);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Resolving an unsupported provider is a controlled 400 (AppError), not a crash.
 * This guards the registry contract after the non-Claude providers were removed.
 */
test('providerMcpService rejects unsupported providers with a controlled error', { concurrency: false }, async () => {
  await assert.rejects(
    providerMcpService.listProviderMcpServers('codex'),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_PROVIDER' &&
      error.statusCode === 400,
  );

  await assert.rejects(
    providerMcpService.upsertProviderMcpServer('opencode', {
      name: 'x',
      scope: 'user',
      transport: 'stdio',
      command: 'node',
    }),
    (error: unknown) => error instanceof AppError && error.code === 'UNSUPPORTED_PROVIDER',
  );
});

/**
 * This test covers the global MCP adder requirement: only http/stdio are allowed and
 * one payload is written to every registered provider. With the fork narrowed to
 * Claude-only, "all providers" is exactly Claude.
 */
test('providerMcpService global adder writes to all registered providers and rejects unsupported transports', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-global-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    const globalResult = await providerMcpService.addMcpServerToAllProviders({
      name: 'global-http',
      scope: 'project',
      transport: 'http',
      url: 'https://global.example.com/mcp',
      workspacePath,
    });

    assert.equal(globalResult.length, 1);
    assert.ok(globalResult.every((entry) => entry.created === true));
    assert.ok(globalResult.some((entry) => entry.provider === 'claude'));

    const claudeProject = await readJson(path.join(workspacePath, '.mcp.json'));
    assert.ok((claudeProject.mcpServers as Record<string, unknown>)['global-http']);

    await assert.rejects(
      providerMcpService.addMcpServerToAllProviders({
        name: 'global-sse',
        scope: 'project',
        transport: 'sse',
        url: 'https://example.com/sse',
        workspacePath,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_GLOBAL_MCP_TRANSPORT' &&
        error.statusCode === 400,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
