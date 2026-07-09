import { safeJsonParse } from '../../../lib/utils.js';
import { authenticatedFetch } from '../../../utils/api';
import type { ChatMessage, ClaudePermissionSuggestion, PermissionGrantResult } from '../types/types.js';

export function buildClaudeToolPermissionEntry(toolName?: string, toolInput?: unknown) {
  if (!toolName) return null;
  if (toolName !== 'Bash') return toolName;

  const parsed = safeJsonParse(toolInput);
  const command = typeof parsed?.command === 'string' ? parsed.command.trim() : '';
  if (!command) return toolName;

  const tokens = command.split(/\s+/);
  if (tokens.length === 0) return toolName;

  if (tokens[0] === 'git' && tokens[1]) {
    return `Bash(${tokens[0]} ${tokens[1]}:*)`;
  }
  return `Bash(${tokens[0]}:*)`;
}

export function formatToolInputForDisplay(input: unknown) {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export function getClaudePermissionSuggestion(
  message: ChatMessage | null | undefined,
  provider: string,
): ClaudePermissionSuggestion | null {
  if (provider !== 'claude') return null;
  if (!message?.toolResult?.isError) return null;

  const toolName = message?.toolName;
  const entry = buildClaudeToolPermissionEntry(toolName, message.toolInput);
  if (!entry) return null;

  // Whether it's already allowed is authoritative only on the server (settings.json),
  // so we don't pre-compute it here; the grant call is idempotent regardless.
  return { toolName: toolName || 'UnknownTool', entry, isAllowed: false };
}

/**
 * Persists a tool-permission grant to the single source — ~/.claude/settings.json
 * permissions.allow — via the server, instead of any app-local store.
 */
export async function grantClaudeToolPermission(entry: string | null): Promise<PermissionGrantResult> {
  if (!entry) return { success: false };

  try {
    const response = await authenticatedFetch('/api/settings/claude-permissions/allow', {
      method: 'POST',
      body: JSON.stringify({ entry }),
    });
    if (!response.ok) {
      return { success: false };
    }
    return { success: true };
  } catch {
    return { success: false };
  }
}
