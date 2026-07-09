import type { Dispatch, SetStateAction } from 'react';

import type { LLMProvider } from '../../../types/app';
import type { ProviderAuthStatus } from '../../provider-auth/types';

export type SettingsMainTab = 'agents' | 'appearance' | 'git' | 'api' | 'voice' | 'tasks' | 'browser' | 'notifications' | 'plugins' | 'shortcuts' | 'about';
export type AgentProvider = LLMProvider;
export type AgentCategory = 'account' | 'permissions' | 'mcp' | 'skills';
export type ProjectSortOrder = 'name' | 'date';
export type SaveStatus = 'success' | 'error' | null;
export type CodexPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';
export type GeminiPermissionMode = 'default' | 'auto_edit' | 'yolo';

export type SettingsProject = {
  name: string;
  displayName?: string;
  fullPath?: string;
  path?: string;
};

export type AuthStatus = ProviderAuthStatus;

// Mirrors permissions.allow / permissions.deny in ~/.claude/settings.json — the single
// source. `skipPermissions` is gone: it maps to bypassPermissions mode (a runtime choice
// via the composer's mode toggle), not a persisted setting.
export type ClaudePermissionsState = {
  allowedTools: string[];
  disallowedTools: string[];
};

export type NotificationPreferencesState = {
  channels: {
    inApp: boolean;
    webPush: boolean;
    desktop: boolean;
    sound: boolean;
  };
  events: {
    actionRequired: boolean;
    stop: boolean;
    error: boolean;
  };
};

export type CursorPermissionsState = {
  allowedCommands: string[];
  disallowedCommands: string[];
  skipPermissions: boolean;
};

export type CodeEditorSettingsState = {
  theme: 'dark' | 'light';
  wordWrap: boolean;
  showMinimap: boolean;
  lineNumbers: boolean;
  fontSize: string;
};

export type SettingsStoragePayload = {
  claude: ClaudePermissionsState & { projectSortOrder: ProjectSortOrder; lastUpdated: string };
  cursor: CursorPermissionsState & { lastUpdated: string };
  codex: { permissionMode: CodexPermissionMode; lastUpdated: string };
};

export type SettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  projects?: SettingsProject[];
  initialTab?: string;
};

export type SetState<T> = Dispatch<SetStateAction<T>>;
