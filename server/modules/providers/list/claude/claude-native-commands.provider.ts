import { query } from '@anthropic-ai/claude-agent-sdk';

import { resolveClaudeCodeExecutablePath } from '../../../../shared/claude-cli-path.js';

/**
 * Native Claude Code slash commands, sourced live from the installed CLI.
 *
 * The app's `/api/commands/list` route historically returned only a hardcoded
 * list of 6 builtins plus filesystem-scanned custom `.md` files — so autocomplete
 * was blind to the ~120 real commands the CLI actually exposes (skills, plugin
 * commands, and native builtins like /clear, /compact, /agents, /context, /init,
 * /review, /usage). This module asks the CLI itself, via the Agent SDK, so the
 * menu always reflects the installed Claude Code version on page load.
 *
 * Mechanism: the SDK exposes `query.supportedCommands()`, but only in streaming
 * input mode and only after the CLI subprocess has finished its `initialize`
 * handshake. We open a streaming query whose prompt iterable never yields (so no
 * turn is ever sent), await the command list once initialize completes (~1s),
 * then abort the query and tear down the subprocess. Result is cached with a
 * short TTL so repeated page loads don't respawn the CLI every time.
 */

export interface NativeSlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
}

interface CacheEntry {
  commands: NativeSlashCommand[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 60_000;
// Hard ceiling on how long we wait for the CLI to hand over its command list
// before giving up and letting the route fall back to the hardcoded builtins.
const FETCH_TIMEOUT_MS = 15_000;

let cache: CacheEntry | null = null;
let inFlight: Promise<NativeSlashCommand[]> | null = null;

/**
 * Open an ephemeral streaming query, pull the CLI's command list once the
 * subprocess initializes, then abort. Never sends a user turn.
 */
async function probeSupportedCommands(cwd?: string): Promise<NativeSlashCommand[]> {
  const abortController = new AbortController();

  // Streaming input mode is entered when `prompt` is an async iterable. Yielding
  // nothing keeps the input side open (no turn is sent) so supportedCommands()
  // can resolve against the initialize handshake, which it does regardless.
  async function* emptyPromptStream() {
    // Park until aborted; the finally-block abort() below unblocks teardown.
    await new Promise<void>((resolve) => {
      abortController.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  const queryInstance = query({
    prompt: emptyPromptStream(),
    options: {
      // Forward the host env (Bedrock proxy vars etc.) to the subprocess.
      env: { ...process.env },
      pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH),
      cwd: cwd || process.cwd(),
      // Match the real query path so the CLI loads the same command surface.
      tools: { type: 'preset', preset: 'claude_code' },
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['project', 'user', 'local'],
      abortController,
    },
  });

  try {
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('supportedCommands() timed out')), FETCH_TIMEOUT_MS);
      // Do not keep the event loop alive on account of this timer.
      if (typeof timer.unref === 'function') timer.unref();
    });

    const commands = (await Promise.race([
      queryInstance.supportedCommands(),
      timeout,
    ])) as NativeSlashCommand[];

    return Array.isArray(commands) ? commands : [];
  } finally {
    abortController.abort();
    try {
      await queryInstance.interrupt?.();
    } catch {
      // Best-effort teardown; the abort above already signals the subprocess.
    }
  }
}

/**
 * Return the CLI's native slash-command list, cached for CACHE_TTL_MS.
 * Never throws — on any failure (CLI missing, timeout, auth), returns [] so the
 * route falls back to the hardcoded builtins and the app still renders.
 */
export async function getNativeSlashCommands(cwd?: string): Promise<NativeSlashCommand[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.commands;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const commands = await probeSupportedCommands(cwd);
      cache = { commands, fetchedAt: Date.now() };
      return commands;
    } catch (error) {
      console.error('Failed to load native slash commands from Claude CLI:', error instanceof Error ? error.message : error);
      // Cache the empty result briefly so a broken CLI doesn't respawn on every keystroke.
      cache = { commands: [], fetchedAt: Date.now() };
      return [];
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Drop the cache so the next request re-probes the CLI (used after reloadPlugins). */
export function invalidateNativeSlashCommandsCache(): void {
  cache = null;
}

export interface ReloadPluginsResult {
  ok: boolean;
  commandCount?: number;
  agentCount?: number;
  error?: string;
}

/**
 * Reload plugins from disk via the SDK control method `query.reloadPlugins()`.
 *
 * `/reload-plugins` is NOT a sendable slash command — the CLI never advertises
 * it through supportedCommands() because the interactive REPL handles it as a
 * client-side control action, not a turn. The SDK mirrors that: it's a method,
 * not text. So this opens an ephemeral streaming query, invokes reloadPlugins(),
 * and reports the refreshed component counts. We also invalidate our command
 * cache so the next /list re-probes and picks up any newly-loaded commands.
 */
export async function reloadPlugins(cwd?: string): Promise<ReloadPluginsResult> {
  const abortController = new AbortController();

  async function* emptyPromptStream() {
    await new Promise<void>((resolve) => {
      abortController.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  const queryInstance = query({
    prompt: emptyPromptStream(),
    options: {
      env: { ...process.env },
      pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH),
      cwd: cwd || process.cwd(),
      tools: { type: 'preset', preset: 'claude_code' },
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['project', 'user', 'local'],
      abortController,
    },
  });

  try {
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('reloadPlugins() timed out')), FETCH_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });

    const response = (await Promise.race([queryInstance.reloadPlugins(), timeout])) as {
      commands?: unknown[];
      agents?: unknown[];
    };

    // Newly loaded plugins may add commands — force the next /list to re-probe.
    invalidateNativeSlashCommandsCache();

    return {
      ok: true,
      commandCount: Array.isArray(response?.commands) ? response.commands.length : undefined,
      agentCount: Array.isArray(response?.agents) ? response.agents.length : undefined,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    abortController.abort();
    try {
      await queryInstance.interrupt?.();
    } catch {
      // Best-effort teardown.
    }
  }
}
