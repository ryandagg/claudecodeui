import { useCallback, useEffect, useRef, useState } from 'react';

import { useSettings } from '../../../contexts/SettingsContext';
import { useTheme } from '../../../contexts/ThemeContext';
import { authenticatedFetch } from '../../../utils/api';
import { NOTIFICATION_SOUND_ENABLED_STORAGE_KEY } from '../../../utils/notificationSound';
import { DEFAULT_CODE_EDITOR_SETTINGS } from '../constants/constants';
import type {
  CodeEditorSettingsState,
  NotificationPreferencesState,
  ProjectSortOrder,
  SettingsMainTab,
} from '../types/types';

type ThemeContextValue = {
  isDarkMode: boolean;
  toggleDarkMode: () => void;
};

type UseSettingsControllerArgs = {
  isOpen: boolean;
  initialTab: string;
};

type NotificationPreferencesResponse = {
  success?: boolean;
  preferences?: NotificationPreferencesState;
};

const KNOWN_MAIN_TABS: SettingsMainTab[] = ['appearance', 'sessions', 'environment', 'notifications', 'shortcuts', 'about'];

const normalizeMainTab = (tab: string): SettingsMainTab =>
  KNOWN_MAIN_TABS.includes(tab as SettingsMainTab) ? (tab as SettingsMainTab) : 'appearance';

const PROJECT_SORT_ORDER_KEY = 'project-sort-order';

const createDefaultNotificationPreferences = (): NotificationPreferencesState => ({
  channels: {
    inApp: true,
    webPush: false,
    desktop: false,
    sound: true,
  },
  events: {
    actionRequired: true,
    stop: true,
    error: true,
  },
});

const normalizeNotificationPreferences = (
  preferences?: Partial<NotificationPreferencesState> | null,
): NotificationPreferencesState => {
  const defaults = createDefaultNotificationPreferences();

  return {
    channels: {
      inApp: preferences?.channels?.inApp ?? defaults.channels.inApp,
      webPush: preferences?.channels?.webPush ?? defaults.channels.webPush,
      desktop: preferences?.channels?.desktop ?? defaults.channels.desktop,
      sound: preferences?.channels?.sound ?? defaults.channels.sound,
    },
    events: {
      actionRequired: preferences?.events?.actionRequired ?? defaults.events.actionRequired,
      stop: preferences?.events?.stop ?? defaults.events.stop,
      error: preferences?.events?.error ?? defaults.events.error,
    },
  };
};

type GetSetting = (key: string, fallback?: string) => string | null;

const readCodeEditorSettings = (getSetting: GetSetting): CodeEditorSettingsState => ({
  theme: getSetting('codeEditorTheme') === 'light' ? 'light' : 'dark',
  wordWrap: getSetting('codeEditorWordWrap') === 'true',
  showMinimap: getSetting('codeEditorShowMinimap') !== 'false',
  lineNumbers: getSetting('codeEditorLineNumbers') !== 'false',
  fontSize: getSetting('codeEditorFontSize') ?? DEFAULT_CODE_EDITOR_SETTINGS.fontSize,
});

export function useSettingsController({ isOpen, initialTab }: UseSettingsControllerArgs) {
  const { isDarkMode, toggleDarkMode } = useTheme() as ThemeContextValue;
  const { getSetting, setSetting } = useSettings();

  const [activeTab, setActiveTab] = useState<SettingsMainTab>(() => normalizeMainTab(initialTab));
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  const [projectSortOrder, setProjectSortOrder] = useState<ProjectSortOrder>('name');
  const [codeEditorSettings, setCodeEditorSettings] = useState<CodeEditorSettingsState>(() => (
    readCodeEditorSettings(getSetting)
  ));
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferencesState>(() => (
    createDefaultNotificationPreferences()
  ));

  const isInitialLoadRef = useRef(true);
  const autoSaveTimerRef = useRef<number | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      setProjectSortOrder(getSetting(PROJECT_SORT_ORDER_KEY) === 'date' ? 'date' : 'name');
      setCodeEditorSettings(readCodeEditorSettings(getSetting));

      try {
        const notificationResponse = await authenticatedFetch('/api/settings/notification-preferences');
        if (notificationResponse.ok) {
          const notificationData = await notificationResponse.json() as NotificationPreferencesResponse;
          if (notificationData.success && notificationData.preferences) {
            setNotificationPreferences(normalizeNotificationPreferences(notificationData.preferences));
          } else {
            setNotificationPreferences(createDefaultNotificationPreferences());
          }
        } else {
          setNotificationPreferences(createDefaultNotificationPreferences());
        }
      } catch {
        setNotificationPreferences(createDefaultNotificationPreferences());
      }
    } catch (error) {
      console.error('Error loading settings:', error);
      setNotificationPreferences(createDefaultNotificationPreferences());
      setProjectSortOrder('name');
    }
  }, [getSetting]);

  const saveSettings = useCallback(async () => {
    setSaveStatus(null);

    try {
      setSetting(PROJECT_SORT_ORDER_KEY, projectSortOrder);

      const notificationResponse = await authenticatedFetch('/api/settings/notification-preferences', {
        method: 'PUT',
        body: JSON.stringify(notificationPreferences),
      });
      if (!notificationResponse.ok) {
        throw new Error('Failed to save notification preferences');
      }

      setSaveStatus('success');
    } catch (error) {
      console.error('Error saving settings:', error);
      setSaveStatus('error');
    }
  }, [notificationPreferences, projectSortOrder, setSetting]);

  const updateCodeEditorSetting = useCallback(
    <K extends keyof CodeEditorSettingsState>(key: K, value: CodeEditorSettingsState[K]) => {
      setCodeEditorSettings((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      prevOpenRef.current = false;
      return;
    }

    if (!prevOpenRef.current) {
      setActiveTab(normalizeMainTab(initialTab));
      prevOpenRef.current = true;
    }
    void loadSettings();
  }, [initialTab, isOpen, loadSettings]);

  useEffect(() => {
    setSetting(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, String(notificationPreferences.channels.sound));
  }, [notificationPreferences.channels.sound, setSetting]);

  useEffect(() => {
    setSetting('codeEditorTheme', codeEditorSettings.theme);
    setSetting('codeEditorWordWrap', String(codeEditorSettings.wordWrap));
    setSetting('codeEditorShowMinimap', String(codeEditorSettings.showMinimap));
    setSetting('codeEditorLineNumbers', String(codeEditorSettings.lineNumbers));
    setSetting('codeEditorFontSize', codeEditorSettings.fontSize);
  }, [codeEditorSettings, setSetting]);

  useEffect(() => {
    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
      return;
    }

    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = window.setTimeout(() => {
      saveSettings();
    }, 500);

    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [saveSettings]);

  useEffect(() => {
    if (saveStatus === null) {
      return;
    }

    const timer = window.setTimeout(() => setSaveStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  useEffect(() => {
    if (isOpen) {
      isInitialLoadRef.current = true;
    }
  }, [isOpen]);

  useEffect(() => () => {
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, []);

  return {
    activeTab,
    setActiveTab,
    isDarkMode,
    toggleDarkMode,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
    notificationPreferences,
    setNotificationPreferences,
  };
}
