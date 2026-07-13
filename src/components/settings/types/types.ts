export type SettingsMainTab = 'appearance' | 'sessions' | 'notifications' | 'shortcuts' | 'about';
export type ProjectSortOrder = 'name' | 'date';
export type SaveStatus = 'success' | 'error' | null;

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

export type CodeEditorSettingsState = {
  theme: 'dark' | 'light';
  wordWrap: boolean;
  showMinimap: boolean;
  lineNumbers: boolean;
  fontSize: string;
};

export type SettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: string;
};
