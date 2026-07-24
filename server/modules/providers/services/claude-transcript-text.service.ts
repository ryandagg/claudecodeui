/**
 * Extracts user-visible, searchable text from Claude transcript JSONL entries.
 *
 * Claude mixes visible chat, compact summaries, local-command wrappers, and
 * tool traffic into one transcript stream. The message index should hold the
 * user-visible meaning of each row (what someone reading the transcript would
 * search for) rather than the raw wrapper syntax. This module is the single
 * source of truth for that mapping; the indexer calls it per line.
 *
 * Scope of indexed content (v1): assistant/user text, tool_result text, and
 * tool *names* (e.g. `Bash`, `Read`). Tool-call arguments and extended-thinking
 * blocks are intentionally excluded for now; they can be added here later
 * without touching the index schema or query path.
 */

type AnyRecord = Record<string, any>;

export type ClaudeSearchableMessage = {
  text: string;
  role: 'user' | 'assistant';
};

/**
 * Prefixes that mark harness-injected or synthetic content that a user never
 * typed and would not search for. Kept in sync with what the transcript UI
 * hides from the visible conversation.
 */
const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  '<task-notification>',
  'Caveat:',
  'Invalid API key',
  '[Request interrupted',
] as const;

const MAX_TOOL_RESULT_SEARCH_LENGTH = 10_000;

function isInternalContent(content: string): boolean {
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/**
 * Flattens a Claude message `content` value into searchable text.
 *
 * Handles the string shorthand and the block array. Indexed block types:
 *  - `text`         → the text itself
 *  - `tool_use`     → the tool NAME only (not its arguments)
 *  - `tool_result`  → the result text (string, or nested text blocks),
 *                     truncated to keep pathological tool outputs bounded
 */
export function extractClaudeText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const parts: string[] = [];

  for (const part of content as AnyRecord[]) {
    if (!part) {
      continue;
    }

    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    } else if (part.type === 'tool_use' && typeof part.name === 'string') {
      // Tool name only — makes "which sessions ran Bash / WebFetch / ..." searchable.
      parts.push(part.name);
    } else if (part.type === 'tool_result') {
      if (typeof part.content === 'string') {
        const text = part.content.length > MAX_TOOL_RESULT_SEARCH_LENGTH
          ? part.content.slice(0, MAX_TOOL_RESULT_SEARCH_LENGTH)
          : part.content;
        parts.push(text);
      } else if (Array.isArray(part.content)) {
        for (const inner of part.content as AnyRecord[]) {
          if (inner?.type === 'text' && typeof inner.text === 'string') {
            const text = inner.text.length > MAX_TOOL_RESULT_SEARCH_LENGTH
              ? inner.text.slice(0, MAX_TOOL_RESULT_SEARCH_LENGTH)
              : inner.text;
            parts.push(text);
          }
        }
      }
    }
  }

  return parts.join(' ');
}

function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

function parseClaudeLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  return {
    commandName: commandName ?? '',
    commandMessage: commandMessage ?? '',
    commandArgs: commandArgs ?? '',
  };
}

function buildClaudeLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}

function stripAnsiFormatting(text: string): string {
  return text.replace(/\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * Maps one raw Claude JSONL entry to `{ text, role }` for indexing, or `null`
 * when the row carries nothing a user would search for.
 *
 * Mirrors the transcript UI's normalization: compact summaries are relabeled
 * assistant, local-command wrappers are shown as the command the user ran,
 * `<local-command-stdout>` is ANSI-stripped, and internal/synthetic rows are
 * dropped.
 */
export function extractClaudeSearchableMessage(entry: AnyRecord): ClaudeSearchableMessage | null {
  if (!entry.message?.content || entry.isApiErrorMessage) {
    return null;
  }

  const rawRole = entry.message.role;
  if (rawRole !== 'user' && rawRole !== 'assistant') {
    return null;
  }

  if (typeof entry.message.content === 'string') {
    const content = String(entry.message.content);

    if (entry.isCompactSummary === true && content.trim()) {
      return { text: content, role: 'assistant' };
    }

    const localCommand = parseClaudeLocalCommandPayload(content);
    if (localCommand) {
      const displayText = buildClaudeLocalCommandDisplayText(localCommand);
      return displayText ? { text: displayText, role: 'user' } : null;
    }

    const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
    if (localCommandStdout !== null) {
      const stdoutText = stripAnsiFormatting(localCommandStdout).trim();
      return stdoutText ? { text: stdoutText, role: 'assistant' } : null;
    }

    if (!content || isInternalContent(content)) {
      return null;
    }

    return { text: content, role: rawRole };
  }

  const text = extractClaudeText(entry.message.content);
  if (!text) {
    return null;
  }

  if (entry.isCompactSummary === true) {
    return { text, role: 'assistant' };
  }

  if (isInternalContent(text)) {
    return null;
  }

  return { text, role: rawRole };
}
