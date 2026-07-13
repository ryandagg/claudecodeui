import type { ComponentType } from 'react';
import {
  Bell,
  EyeOff,
  Info,
  Keyboard,
  Palette,
} from 'lucide-react';

import type {
  CodeEditorSettingsState,
  ProjectSortOrder,
  SettingsMainTab,
} from '../types/types';

export type SettingsMainTabMeta = {
  id: SettingsMainTab;
  label: string;
  keywords: string;
  icon: ComponentType<{ className?: string }>;
};

export const SETTINGS_MAIN_TABS: SettingsMainTabMeta[] = [
  { id: 'appearance', label: 'Appearance', keywords: 'appearance theme dark light language', icon: Palette },
  { id: 'sessions', label: 'Sessions', keywords: 'sessions hide filter regex', icon: EyeOff },
  { id: 'notifications', label: 'Notifications', keywords: 'notifications alerts push', icon: Bell },
  { id: 'shortcuts', label: 'Shortcuts', keywords: 'shortcuts keyboard hotkeys', icon: Keyboard },
  { id: 'about', label: 'About', keywords: 'about version info', icon: Info },
];

export const DEFAULT_PROJECT_SORT_ORDER: ProjectSortOrder = 'name';
export const DEFAULT_SAVE_STATUS = null;
export const DEFAULT_CODE_EDITOR_SETTINGS: CodeEditorSettingsState = {
  theme: 'dark',
  wordWrap: false,
  showMinimap: true,
  lineNumbers: true,
  fontSize: '14',
};
