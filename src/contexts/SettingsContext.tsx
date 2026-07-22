import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { api } from '../utils/api';

type SettingsMap = Record<string, string>;

type SettingsContextValue = {
  settings: SettingsMap;
  ready: boolean;
  getSetting: (key: string, fallback?: string) => string | null;
  setSetting: (key: string, value: string) => void;
  setSettings: (entries: Record<string, string>) => void;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettingsState] = useState<SettingsMap>({});
  const [ready, setReady] = useState(false);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<SettingsMap>({});
  const settingsRef = useRef<SettingsMap>(settings);
  settingsRef.current = settings;

  useEffect(() => {
    api.settings.get().then(async (res) => {
      if (!res.ok) { setReady(true); return; }
      const { settings: loaded } = await res.json();
      if (loaded && typeof loaded === 'object') {
        setSettingsState(loaded);
      }
      setReady(true);
    }).catch(() => { setReady(true); });
  }, []);

  const flushToServer = useCallback(() => {
    const batch = { ...pendingRef.current };
    pendingRef.current = {};
    if (Object.keys(batch).length === 0) return;
    api.settings.put(batch).catch(() => {});
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(flushToServer, 500);
  }, [flushToServer]);

  const setSetting = useCallback((key: string, value: string) => {
    setSettingsState((prev) => {
      if (prev[key] === value) return prev;
      return { ...prev, [key]: value };
    });
    pendingRef.current[key] = value;
    scheduleFlush();
  }, [scheduleFlush]);

  const setSettings = useCallback((entries: Record<string, string>) => {
    setSettingsState((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const [key, value] of Object.entries(entries)) {
        if (next[key] !== value) {
          next[key] = value;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    Object.assign(pendingRef.current, entries);
    scheduleFlush();
  }, [scheduleFlush]);

  const getSetting = useCallback((key: string, fallback?: string) => {
    return settingsRef.current[key] ?? fallback ?? null;
  }, []);

  useEffect(() => {
    return () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushToServer();
      }
    };
  }, [flushToServer]);

  return (
    <SettingsContext.Provider value={{ settings, ready, getSetting, setSetting, setSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}
