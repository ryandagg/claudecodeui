import { useCallback, useMemo } from 'react';

import { useSettings } from '../contexts/SettingsContext';

type UiPreferences = {
  autoExpandTools: boolean;
  showRawParameters: boolean;
  showThinking: boolean;
  autoScrollToBottom: boolean;
  sendByCtrlEnter: boolean;
  sidebarVisible: boolean;
  voiceEnabled: boolean;
};

type UiPreferenceKey = keyof UiPreferences;

const DEFAULTS: UiPreferences = {
  autoExpandTools: false,
  showRawParameters: false,
  showThinking: true,
  autoScrollToBottom: true,
  sendByCtrlEnter: false,
  sidebarVisible: true,
  voiceEnabled: false,
};

const PREFERENCE_KEYS = Object.keys(DEFAULTS) as UiPreferenceKey[];
const STORAGE_KEY = 'uiPreferences';

const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
};

export function useUiPreferences() {
  const { getSetting, setSetting } = useSettings();

  const preferences: UiPreferences = useMemo(() => {
    const raw = getSetting(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return PREFERENCE_KEYS.reduce((acc, key) => {
            acc[key] = parseBoolean(parsed[key], DEFAULTS[key]);
            return acc;
          }, { ...DEFAULTS });
        }
      } catch { /* fall through to defaults */ }
    }
    return { ...DEFAULTS };
  }, [getSetting]);

  const setPreference = useCallback((key: UiPreferenceKey, value: unknown) => {
    const next = { ...preferences, [key]: parseBoolean(value, preferences[key]) };
    setSetting(STORAGE_KEY, JSON.stringify(next));
  }, [preferences, setSetting]);

  const setPreferences = useCallback((updates: Partial<Record<UiPreferenceKey, unknown>>) => {
    const next = { ...preferences };
    for (const key of PREFERENCE_KEYS) {
      if (key in updates) {
        next[key] = parseBoolean(updates[key], preferences[key]);
      }
    }
    setSetting(STORAGE_KEY, JSON.stringify(next));
  }, [preferences, setSetting]);

  const resetPreferences = useCallback((value?: Partial<UiPreferences>) => {
    const next = { ...DEFAULTS, ...(value || {}) };
    setSetting(STORAGE_KEY, JSON.stringify(next));
  }, [setSetting]);

  return {
    preferences,
    setPreference,
    setPreferences,
    resetPreferences,
  };
}
