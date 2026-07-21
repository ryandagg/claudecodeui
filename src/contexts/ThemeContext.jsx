import React, { createContext, useContext, useState, useEffect } from 'react';

import { useSettings } from './SettingsContext';

const ThemeContext = createContext();

// eslint-disable-next-line react-refresh/only-export-components
export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

export const ThemeProvider = ({ children }) => {
  const { getSetting, setSetting, ready } = useSettings();

  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = getSetting('theme');
    if (saved) return saved === 'dark';
    if (window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  });

  // Re-sync when settings finish loading from DB
  useEffect(() => {
    if (!ready) return;
    const saved = getSetting('theme');
    if (saved) {
      setIsDarkMode(saved === 'dark');
    }
  }, [ready, getSetting]);

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
      const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (statusBarMeta) statusBarMeta.setAttribute('content', 'black-translucent');
      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) themeColorMeta.setAttribute('content', '#0c1117');
    } else {
      document.documentElement.classList.remove('dark');
      const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (statusBarMeta) statusBarMeta.setAttribute('content', 'default');
      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) themeColorMeta.setAttribute('content', '#ffffff');
    }
  }, [isDarkMode]);

  // Listen for system theme changes
  useEffect(() => {
    if (!window.matchMedia) return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e) => {
      const saved = getSetting('theme');
      if (!saved) setIsDarkMode(e.matches);
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [getSetting]);

  const toggleDarkMode = () => {
    setIsDarkMode(prev => {
      const next = !prev;
      setSetting('theme', next ? 'dark' : 'light');
      return next;
    });
  };

  return (
    <ThemeContext.Provider value={{ isDarkMode, toggleDarkMode }}>
      {children}
    </ThemeContext.Provider>
  );
};
