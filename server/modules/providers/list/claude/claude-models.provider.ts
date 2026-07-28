import { readFile } from 'node:fs/promises';

import { query, type ModelInfo } from '@anthropic-ai/claude-agent-sdk';

import { sessionsDb } from '@/modules/database/index.js';
import {
  CLAUDE_DEFAULT_MODEL_VALUE,
  readClaudeModel,
} from '@/modules/providers/list/claude/claude-settings.provider.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

/**
 * Effort preselected for models that support it. The SDK reports which levels a
 * model allows but not which to start on, so the app keeps its existing choice.
 */
const CLAUDE_DEFAULT_EFFORT = 'high';

/**
 * Last-resort catalog for when the SDK cannot be asked what it supports.
 *
 * These are floating aliases: Claude resolves `opus` to whatever the current Opus
 * is, so the labels deliberately carry no version number — a hardcoded "4.8" here
 * would silently become a lie on the next model release. The live catalog from
 * `getSupportedModels()` reports concrete versions because it reads them from the
 * SDK at call time.
 */
export const CLAUDE_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Use whichever model your Claude settings select',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'fable',
      label: 'Fable',
      description: 'Most capable for the hardest and longest-running tasks',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Best for everyday tasks',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet (1M context)',
      description: 'Sonnet for long sessions',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Most capable for complex work',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'opus[1m]',
      label: 'Opus (1M context)',
      description: 'Opus for long sessions',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Fastest for quick answers',
    },
  ],
  DEFAULT: 'default',
};

export const findClaudeModelOption = (model: string | undefined | null): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) return null;
  return CLAUDE_FALLBACK_MODELS.OPTIONS.find((option) => option.value === normalizedModel) ?? null;
};

/**
 * Maps the SDK's own model list into the app's provider catalog shape.
 *
 * `ModelInfo.value` is the identifier Claude itself uses in API calls, which is
 * exactly what `~/.claude/settings.json` stores for `model`. Keeping it verbatim
 * makes the catalog and the settings file speak one vocabulary: the dropdown can
 * match the stored value exactly, and writing a selection back is an identity
 * round-trip rather than a lossy alias translation.
 *
 * Labels, descriptions, and effort levels also come from the SDK, so the list
 * reflects what the active profile (Bedrock gateway included) actually offers
 * instead of a hand-maintained snapshot that silently drifts.
 */
const buildClaudeModelsDefinition = (models: ModelInfo[]): ProviderModelsDefinition => {
  const options: ProviderModelOption[] = models.map((model) => {
    const efforts = model.supportsEffort ? model.supportedEffortLevels ?? [] : [];
    return {
      value: model.value,
      label: model.displayName || model.value,
      ...(model.description ? { description: model.description } : {}),
      ...(efforts.length > 0
        ? {
          effort: {
            default: CLAUDE_DEFAULT_EFFORT,
            values: efforts.map((value) => ({ value })),
          },
        }
        : {}),
    };
  });

  if (options.length === 0) {
    return CLAUDE_FALLBACK_MODELS;
  }

  // The SDK advertises its own 'default' sentinel; prefer it so "let Claude
  // decide" survives, and fall back to the first entry if it ever disappears.
  const hasDefaultSentinel = options.some((option) => option.value === CLAUDE_DEFAULT_MODEL_VALUE);
  return {
    OPTIONS: options,
    DEFAULT: hasDefaultSentinel ? CLAUDE_DEFAULT_MODEL_VALUE : options[0].value,
  };
};

type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

const ANSI_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:'
  + '(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]'
  + '|(?:[\\dA-PR-TZcf-ntqry=><~]))',
  'g',
);

const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel || null;
};

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, '');

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsi(localCommandStdout).replace(/\s+/g, ' ').trim();
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
    if (changedModel?.[1]?.trim()) {
      return changedModel[1].trim();
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag || null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const content = await readFile(jsonlPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as ClaudeInitEvent;
      const model = extractClaudeEventModel(event, sessionId);
      if (model) {
        return { model };
      }
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  return null;
};

export class ClaudeProviderModels implements IProviderModels {
  /**
   * Asks the SDK which models the current profile can actually run.
   *
   * `persistSession: false` is what makes this viable: the query would otherwise
   * write a session JSONL and register the invoking directory as a bogus
   * workspace, which is why this lookup used to be hardcoded instead.
   *
   * The hardcoded list stays as a fallback for when the SDK cannot be reached.
   */
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    let queryInstance: ReturnType<typeof query> | null = null;
    try {
      queryInstance = query({
        prompt: 'Get supported models',
        options: {
          settingSources: ['user'],
          persistSession: false,
        },
      });

      return buildClaudeModelsDefinition(await queryInstance.supportedModels());
    } catch (error) {
      console.warn('[Claude models] Unable to read supported models from the SDK:', error);
      return CLAUDE_FALLBACK_MODELS;
    } finally {
      try {
        queryInstance?.close();
      } catch {
        // A close failure on a throwaway query is not worth surfacing.
      }
    }
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      // The default model is owned by ~/.claude/settings.json (the single source,
      // shared with the terminal). Catalog values are the SDK's own model IDs —
      // the same vocabulary that file uses — so the stored value passes straight
      // through and the UI can match it exactly.
      try {
        const stored = await readClaudeModel();
        return { model: stored ?? CLAUDE_DEFAULT_MODEL_VALUE };
      } catch {
        return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
      }
    }

    try {
      const jsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
      const activeModel = jsonlPath
        ? await readClaudeSessionModelFromJsonl(sessionId, jsonlPath)
        : null;
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('claude', input);
  }
}
