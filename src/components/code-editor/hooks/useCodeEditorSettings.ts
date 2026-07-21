import { useEffect, useRef, useState } from 'react';

import { useSettings } from '../../../contexts/SettingsContext';
import {
  CODE_EDITOR_DEFAULTS,
  CODE_EDITOR_STORAGE_KEYS,
} from '../constants/settings';

const parseTheme = (saved: string | null) => (
  saved ? saved === 'dark' : CODE_EDITOR_DEFAULTS.isDarkMode
);

const parseBoolean = (value: string | null, defaultValue: boolean, falseValue = 'false') => (
  value === null ? defaultValue : value !== falseValue
);

const parseWordWrap = (saved: string | null) => saved === 'true';

const parseFontSize = (saved: string | null) => Number(saved ?? CODE_EDITOR_DEFAULTS.fontSize);

export const useCodeEditorSettings = () => {
  const { getSetting, setSetting, ready } = useSettings();

  const [isDarkMode, setIsDarkMode] = useState(() => parseTheme(getSetting(CODE_EDITOR_STORAGE_KEYS.theme)));
  const [wordWrap, setWordWrap] = useState(() => parseWordWrap(getSetting(CODE_EDITOR_STORAGE_KEYS.wordWrap)));
  const [minimapEnabled, setMinimapEnabled] = useState(() => (
    parseBoolean(getSetting(CODE_EDITOR_STORAGE_KEYS.showMinimap), CODE_EDITOR_DEFAULTS.minimapEnabled)
  ));
  const [showLineNumbers, setShowLineNumbers] = useState(() => (
    parseBoolean(getSetting(CODE_EDITOR_STORAGE_KEYS.lineNumbers), CODE_EDITOR_DEFAULTS.showLineNumbers)
  ));
  const [fontSize, setFontSize] = useState(() => parseFontSize(getSetting(CODE_EDITOR_STORAGE_KEYS.fontSize)));

  const didHydrateThemeRef = useRef(false);
  const didHydrateWordWrapRef = useRef(false);

  // Keep legacy behavior where the editor writes theme and wrap settings directly.
  // Skip the first run so the pre-load default never clobbers the stored value.
  useEffect(() => {
    if (!didHydrateThemeRef.current) {
      didHydrateThemeRef.current = true;
      return;
    }
    setSetting(CODE_EDITOR_STORAGE_KEYS.theme, isDarkMode ? 'dark' : 'light');
  }, [isDarkMode, setSetting]);

  useEffect(() => {
    if (!didHydrateWordWrapRef.current) {
      didHydrateWordWrapRef.current = true;
      return;
    }
    setSetting(CODE_EDITOR_STORAGE_KEYS.wordWrap, String(wordWrap));
  }, [wordWrap, setSetting]);

  // Re-sync from settings once the DB load completes or the Settings modal
  // persists a change to any of the code-editor keys.
  useEffect(() => {
    setIsDarkMode(parseTheme(getSetting(CODE_EDITOR_STORAGE_KEYS.theme)));
    setWordWrap(parseWordWrap(getSetting(CODE_EDITOR_STORAGE_KEYS.wordWrap)));
    setMinimapEnabled(parseBoolean(getSetting(CODE_EDITOR_STORAGE_KEYS.showMinimap), CODE_EDITOR_DEFAULTS.minimapEnabled));
    setShowLineNumbers(parseBoolean(getSetting(CODE_EDITOR_STORAGE_KEYS.lineNumbers), CODE_EDITOR_DEFAULTS.showLineNumbers));
    setFontSize(parseFontSize(getSetting(CODE_EDITOR_STORAGE_KEYS.fontSize)));
  }, [ready, getSetting]);

  return {
    isDarkMode,
    setIsDarkMode,
    wordWrap,
    setWordWrap,
    minimapEnabled,
    setMinimapEnabled,
    showLineNumbers,
    setShowLineNumbers,
    fontSize,
    setFontSize,
  };
};
