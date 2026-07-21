import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { safeLocalStorage } from '../utils/chatStorage';
import type { LLMProvider, Project } from '../../../types/app';

const COMMAND_QUERY_DEBOUNCE_MS = 150;

export interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: 'built-in' | 'custom' | 'skill' | string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface UseSlashCommandsOptions {
  selectedProject: Project | null;
  provider: LLMProvider;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
  onExecuteCommand: (command: SlashCommand, rawInput?: string) => void | Promise<void>;
}

type ProviderSkill = {
  name: string;
  description?: string;
  command: string;
  scope: string;
  sourcePath?: string;
  pluginName?: string;
  pluginId?: string;
};

type ProviderSkillsResponse = {
  success?: boolean;
  data?: {
    skills?: ProviderSkill[];
  };
};

const getCommandHistoryKey = (projectName: string) => `command_history_${projectName}`;

const readCommandHistory = (projectName: string): Record<string, number> => {
  const history = safeLocalStorage.getItem(getCommandHistoryKey(projectName));
  if (!history) {
    return {};
  }

  try {
    return JSON.parse(history);
  } catch (error) {
    console.error('Error parsing command history:', error);
    return {};
  }
};

const saveCommandHistory = (projectName: string, history: Record<string, number>) => {
  safeLocalStorage.setItem(getCommandHistoryKey(projectName), JSON.stringify(history));
};

const isPromiseLike = (value: unknown): value is Promise<unknown> =>
  Boolean(value) && typeof (value as Promise<unknown>).then === 'function';

const isSkillCommand = (command: SlashCommand) =>
  command.type === 'skill' || command.metadata?.type === 'skill';

// Native commands (the ones the installed CLI advertises via supportedCommands)
// and skills are BOTH insert-only: we drop their text into the composer and let
// the normal send path forward it to the SDK, which expands them. Routing them
// through /api/commands/execute would 400 (no commandPath), so never execute them.
const isNativeCommand = (command: SlashCommand) =>
  command.type === 'native' || command.metadata?.type === 'native';

const isInsertOnlyCommand = (command: SlashCommand) =>
  isSkillCommand(command) || isNativeCommand(command);

// A control command isn't sendable text at all — it maps to an SDK control method
// (e.g. reloadPlugins()). /reload-plugins is REPL-only, never advertised by the
// CLI, so we inject it here and dispatch it to its own backend route on select.
const isControlCommand = (command: SlashCommand) =>
  command.type === 'control' || typeof command.metadata?.action === 'string';

const RELOAD_PLUGINS_COMMAND: SlashCommand = {
  name: '/reload-plugins',
  description: 'Reload plugins from disk and refresh the available commands',
  namespace: 'builtin',
  type: 'control',
  metadata: { type: 'control', action: 'reload-plugins' },
};

const dedupeProviderSkills = (skills: ProviderSkill[]): ProviderSkill[] => {
  const seenCommands = new Set<string>();

  return skills.filter((skill) => {
    // Multiple physical Claude plugin folders can expose the same invocation.
    // The slash menu should show each executable command only once.
    const key = skill.command;
    if (seenCommands.has(key)) {
      return false;
    }

    seenCommands.add(key);
    return true;
  });
};

const mapSkillToSlashCommand = (skill: ProviderSkill): SlashCommand => ({
  name: skill.command,
  description: skill.description,
  namespace: 'skill',
  path: skill.sourcePath,
  type: 'skill',
  metadata: {
    type: skill.scope,
    scope: skill.scope,
    sourcePath: skill.sourcePath,
    pluginName: skill.pluginName,
    pluginId: skill.pluginId,
    skillName: skill.name,
  },
});

const filterSlashCommands = (
  commands: SlashCommand[],
  query: string,
): SlashCommand[] => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return commands;
  }

  const commandPrefix = normalizedQuery.startsWith('/')
    ? normalizedQuery
    : `/${normalizedQuery}`;
  const namePrefixMatches = commands.filter((command) =>
    command.name.toLowerCase().startsWith(commandPrefix),
  );

  // Namespaced commands should behave like path completion. Once a provider
  // namespace is typed, only exact command-prefix matches should stay visible.
  if (normalizedQuery.includes(':') || namePrefixMatches.length > 0) {
    return namePrefixMatches;
  }

  const nameSubstringMatches = commands.filter((command) =>
    command.name.toLowerCase().includes(normalizedQuery),
  );
  if (nameSubstringMatches.length > 0) {
    return nameSubstringMatches;
  }

  return commands.filter((command) =>
    command.description?.toLowerCase().includes(normalizedQuery),
  );
};

export function useSlashCommands({
  selectedProject,
  provider,
  input,
  setInput,
  textareaRef,
  onExecuteCommand,
}: UseSlashCommandsOptions) {
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([]);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(-1);
  const [slashPosition, setSlashPosition] = useState(-1);
  // Bumped after /reload-plugins so the command list re-fetches and surfaces any
  // newly-loaded plugin commands without a page reload.
  const [commandListVersion, setCommandListVersion] = useState(0);

  const commandQueryTimerRef = useRef<number | null>(null);

  const clearCommandQueryTimer = useCallback(() => {
    if (commandQueryTimerRef.current !== null) {
      window.clearTimeout(commandQueryTimerRef.current);
      commandQueryTimerRef.current = null;
    }
  }, []);

  const resetCommandMenuState = useCallback(() => {
    setShowCommandMenu(false);
    setSlashPosition(-1);
    setCommandQuery('');
    setSelectedCommandIndex(-1);
    clearCommandQueryTimer();
  }, [clearCommandQueryTimer]);

  useEffect(() => {
    let cancelled = false;
    const skillsController = new AbortController();

    const fetchCommands = async () => {
      if (!selectedProject) {
        setSlashCommands([]);
        setFilteredCommands([]);
        return;
      }

      const workspacePath = selectedProject.fullPath || selectedProject.path || '';

      // Sort a command set by this project's usage history (most-used first).
      const sortByUsage = (commands: SlashCommand[]): SlashCommand[] => {
        const parsedHistory = readCommandHistory(selectedProject.projectId);
        return [...commands].sort((commandA, commandB) => {
          const commandAUsage = parsedHistory[commandA.name] || 0;
          const commandBUsage = parsedHistory[commandB.name] || 0;
          return commandBUsage - commandAUsage;
        });
      };

      // The base command set — everything from /api/commands/list. This resolves
      // fast (native probe is cached, ~500ms cold) and MUST render on its own:
      // skills are fetched separately below and folded in only when/if they
      // arrive. Gating the whole menu on skills was the "No commands available"
      // bug — a slow skills scan (it walks ~/.claude/plugins, 100k+ files) left
      // the 116 ready native commands invisible.
      let baseCommands: SlashCommand[] = [];

      try {
        const response = await authenticatedFetch('/api/commands/list', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            projectPath: workspacePath || selectedProject.path,
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to fetch commands');
        }

        const data = await response.json();
        baseCommands = [
          ...((data.builtIn || []) as SlashCommand[]).map((command) => ({
            ...command,
            type: 'built-in',
          })),
          // Native commands the installed CLI advertises (via supportedCommands()):
          // /clear, /compact, /agents, /context, /init, /review, /usage, plugin
          // commands, etc. — everything the terminal offers, so autocomplete on
          // page load mirrors the actual installed Claude Code version.
          ...((data.native || []) as SlashCommand[]).map((command) => ({
            ...command,
            type: 'native',
          })),
          ...((data.custom || []) as SlashCommand[]).map((command) => ({
            ...command,
            type: 'custom',
          })),
          // /reload-plugins is a REPL-only control action the CLI never advertises;
          // inject it so it's discoverable and dispatch it via reloadPlugins().
          RELOAD_PLUGINS_COMMAND,
        ];

        if (!cancelled) {
          setSlashCommands(sortByUsage(baseCommands));
        }
      } catch (error) {
        console.error('Error fetching slash commands:', error);
        if (!cancelled) {
          setSlashCommands([]);
        }
        return;
      }

      // Skills, fetched separately so they never block the base menu. Bounded by
      // an abort timeout: the skills scan can hang under load, and a stuck fetch
      // must not wipe (or delay) the commands the user already sees.
      try {
        const skillsParams = new URLSearchParams();
        if (workspacePath) {
          skillsParams.set('workspacePath', workspacePath);
        }

        const skillsTimeout = window.setTimeout(() => skillsController.abort(), 10_000);

        const skillsResponse = await authenticatedFetch(
          `/api/providers/${encodeURIComponent(provider)}/skills${skillsParams.toString() ? `?${skillsParams.toString()}` : ''}`,
          { signal: skillsController.signal },
        ).finally(() => window.clearTimeout(skillsTimeout));

        const skillsData = skillsResponse.ok
          ? ((await skillsResponse.json()) as ProviderSkillsResponse)
          : null;
        const skillCommands = dedupeProviderSkills(skillsData?.data?.skills || [])
          .map(mapSkillToSlashCommand);

        // Fold skills into the already-rendered menu, grouped right after the
        // built-ins (matching the original ordering before usage-sort).
        if (!cancelled && skillCommands.length > 0) {
          const builtIns = baseCommands.filter((command) => command.type === 'built-in');
          const others = baseCommands.filter((command) => command.type !== 'built-in');
          setSlashCommands(sortByUsage([...builtIns, ...skillCommands, ...others]));
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('Error fetching provider skills (menu still usable):', error);
      }
    };

    fetchCommands();
    return () => {
      cancelled = true;
      skillsController.abort();
    };
  }, [selectedProject, provider, commandListVersion]);

  useEffect(() => {
    if (!showCommandMenu) {
      setSelectedCommandIndex(-1);
    }
  }, [showCommandMenu]);

  useEffect(() => {
    setFilteredCommands(filterSlashCommands(slashCommands, commandQuery));
  }, [commandQuery, slashCommands]);

  const frequentCommands = useMemo(() => {
    if (!selectedProject || slashCommands.length === 0) {
      return [];
    }

    const parsedHistory = readCommandHistory(selectedProject.projectId);

    return slashCommands
      .map((command) => ({
        ...command,
        usageCount: parsedHistory[command.name] || 0,
      }))
      .filter((command) => command.usageCount > 0)
      .sort((commandA, commandB) => commandB.usageCount - commandA.usageCount)
      .slice(0, 5);
  }, [selectedProject, slashCommands]);

  const trackCommandUsage = useCallback(
    (command: SlashCommand) => {
      if (!selectedProject) {
        return;
      }

      const parsedHistory = readCommandHistory(selectedProject.projectId);
      parsedHistory[command.name] = (parsedHistory[command.name] || 0) + 1;
      saveCommandHistory(selectedProject.projectId, parsedHistory);
    },
    [selectedProject],
  );

  const insertCommandIntoInput = useCallback(
    (command: SlashCommand) => {
      const currentTextarea = textareaRef.current;
      const insertionStart = slashPosition >= 0
        ? slashPosition
        : currentTextarea?.selectionStart ?? input.length;
      const textBeforeCommand = input.slice(0, insertionStart);
      const textAfterCommandStart = input.slice(insertionStart);
      const spaceIndex = textAfterCommandStart.indexOf(' ');
      const textAfterCommand = slashPosition >= 0 && spaceIndex !== -1
        ? textAfterCommandStart.slice(spaceIndex).trimStart()
        : input.slice(currentTextarea?.selectionEnd ?? insertionStart);
      const separator = textBeforeCommand && !/\s$/.test(textBeforeCommand) ? ' ' : '';
      const newInput = `${textBeforeCommand}${separator}${command.name}${textAfterCommand ? ` ${textAfterCommand}` : ' '}`;

      setInput(newInput);
      resetCommandMenuState();

      window.requestAnimationFrame(() => {
        currentTextarea?.focus();
        const nextCursorPosition = `${textBeforeCommand}${separator}${command.name} `.length;
        currentTextarea?.setSelectionRange(nextCursorPosition, nextCursorPosition);
      });
    },
    [input, resetCommandMenuState, setInput, slashPosition, textareaRef],
  );

  const executeNonSkillCommand = useCallback(
    (command: SlashCommand) => {
      const executionResult = onExecuteCommand(command);
      if (isPromiseLike(executionResult)) {
        executionResult.then(
          () => {
            resetCommandMenuState();
          },
          () => {
            resetCommandMenuState();
            // Keep behavior silent; execution errors are handled by caller.
          },
        );
      } else {
        resetCommandMenuState();
      }
    },
    [onExecuteCommand, resetCommandMenuState],
  );

  const dispatchControlCommand = useCallback(
    (command: SlashCommand) => {
      const action = command.metadata?.action;

      // A control command isn't sendable text, so strip the trigger token the
      // user typed (e.g. "/reload-plugins") out of the composer instead of
      // leaving it stranded. Mirror the slice logic insertCommandIntoInput uses.
      const currentTextarea = textareaRef.current;
      const removalStart = slashPosition >= 0
        ? slashPosition
        : currentTextarea?.selectionStart ?? input.length;
      const textBeforeCommand = input.slice(0, removalStart);
      const textAfterCommandStart = input.slice(removalStart);
      const spaceIndex = textAfterCommandStart.indexOf(' ');
      const textAfterCommand = slashPosition >= 0 && spaceIndex !== -1
        ? textAfterCommandStart.slice(spaceIndex).trimStart()
        : input.slice(currentTextarea?.selectionEnd ?? removalStart);
      setInput(`${textBeforeCommand}${textAfterCommand}`);

      resetCommandMenuState();

      if (action === 'reload-plugins') {
        const workspacePath =
          selectedProject?.fullPath || selectedProject?.path || '';
        void authenticatedFetch('/api/commands/reload-plugins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectPath: workspacePath || undefined }),
        })
          .then(async (response) => {
            if (!response.ok) {
              throw new Error('reload-plugins request failed');
            }
            // Force the command list to re-fetch so newly-loaded plugin commands
            // appear in autocomplete immediately.
            setCommandListVersion((version) => version + 1);
          })
          .catch((error) => {
            console.error('Error reloading plugins:', error);
          });
      }
    },
    [resetCommandMenuState, selectedProject, input, setInput, slashPosition, textareaRef],
  );

  const selectCommandFromKeyboard = useCallback(
    (command: SlashCommand) => {
      if (isControlCommand(command)) {
        dispatchControlCommand(command);
        return;
      }

      if (isInsertOnlyCommand(command)) {
        insertCommandIntoInput(command);
        return;
      }

      executeNonSkillCommand(command);
    },
    [dispatchControlCommand, executeNonSkillCommand, insertCommandIntoInput],
  );

  const handleCommandSelect = useCallback(
    (command: SlashCommand | null, index: number, isHover: boolean) => {
      if (!command || !selectedProject) {
        return;
      }

      if (isHover) {
        setSelectedCommandIndex(index);
        return;
      }

      trackCommandUsage(command);
      if (isControlCommand(command)) {
        dispatchControlCommand(command);
        return;
      }

      if (isInsertOnlyCommand(command)) {
        insertCommandIntoInput(command);
        return;
      }

      executeNonSkillCommand(command);
    },
    [selectedProject, trackCommandUsage, dispatchControlCommand, insertCommandIntoInput, executeNonSkillCommand],
  );

  const handleToggleCommandMenu = useCallback(() => {
    const isOpening = !showCommandMenu;
    setShowCommandMenu(isOpening);
    setCommandQuery('');
    setSelectedCommandIndex(-1);

    if (isOpening) {
      setFilteredCommands(slashCommands);
    }

    textareaRef.current?.focus();
  }, [showCommandMenu, slashCommands, textareaRef]);

  const handleCommandInputChange = useCallback(
    (newValue: string, cursorPos: number) => {
      if (!newValue.trim()) {
        resetCommandMenuState();
        return;
      }

      const textBeforeCursor = newValue.slice(0, cursorPos);
      const backticksBefore = (textBeforeCursor.match(/```/g) || []).length;
      const inCodeBlock = backticksBefore % 2 === 1;

      if (inCodeBlock) {
        resetCommandMenuState();
        return;
      }

      // Match / at start of input OR after whitespace, capturing the /word up to cursor.
      const slashPattern = /(?:^|\s)(\/\S*)$/;
      const match = textBeforeCursor.match(slashPattern);

      if (!match) {
        resetCommandMenuState();
        return;
      }

      // Compute actual position of / in the full input string.
      const slashPos = match.index! + (match[0].length - match[1].length);
      const query = match[1].slice(1); // strip leading /

      setSlashPosition(slashPos);
      setShowCommandMenu(true);
      setSelectedCommandIndex(-1);

      clearCommandQueryTimer();
      commandQueryTimerRef.current = window.setTimeout(() => {
        setCommandQuery(query);
      }, COMMAND_QUERY_DEBOUNCE_MS);
    },
    [resetCommandMenuState, clearCommandQueryTimer],
  );

  const handleCommandMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showCommandMenu) {
        return false;
      }

      if (!filteredCommands.length) {
        if (event.key === 'Escape') {
          event.preventDefault();
          resetCommandMenuState();
          return true;
        }
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedCommandIndex((previousIndex) =>
          previousIndex < filteredCommands.length - 1 ? previousIndex + 1 : 0,
        );
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedCommandIndex((previousIndex) =>
          previousIndex > 0 ? previousIndex - 1 : filteredCommands.length - 1,
        );
        return true;
      }

      // Tab always accepts a suggestion (the highlighted one, else the first
      // match) — it's the explicit "autocomplete" affordance.
      if (event.key === 'Tab') {
        event.preventDefault();
        if (selectedCommandIndex >= 0) {
          selectCommandFromKeyboard(filteredCommands[selectedCommandIndex]);
        } else if (filteredCommands.length > 0) {
          selectCommandFromKeyboard(filteredCommands[0]);
        }
        return true;
      }

      // Enter only acts on a command the user explicitly arrow-selected. With
      // nothing highlighted we let the keypress fall through to normal submit
      // so the literal typed text is sent (or run, if it exactly names a
      // command) rather than silently swapped for the nearest fuzzy match —
      // e.g. typing "/mcp" + Enter no longer fires "/mcp-auth". Close the menu
      // so it doesn't linger over the now-submitted input.
      if (event.key === 'Enter') {
        if (selectedCommandIndex >= 0) {
          event.preventDefault();
          selectCommandFromKeyboard(filteredCommands[selectedCommandIndex]);
          return true;
        }
        resetCommandMenuState();
        return false;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        resetCommandMenuState();
        return true;
      }

      return false;
    },
    [showCommandMenu, filteredCommands, resetCommandMenuState, selectCommandFromKeyboard, selectedCommandIndex],
  );

  useEffect(
    () => () => {
      clearCommandQueryTimer();
    },
    [clearCommandQueryTimer],
  );

  return {
    slashCommands,
    slashCommandsCount: slashCommands.length,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  };
}
