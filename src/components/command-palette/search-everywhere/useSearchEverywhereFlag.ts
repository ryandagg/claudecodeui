import { useEffect, useState } from 'react';

import { SEARCH_EVERYWHERE_FLAG_KEY, isSearchEverywhereEnabled } from './searchEverywhereModel';

const safeStorage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
};

/**
 * `localStorage['cloudcli.flags.searchEverywhere']` — default OFF. Re-reads on
 * the `storage` event so flipping it in another tab (or devtools, followed by
 * a focus change) takes effect without a reload.
 */
export function useSearchEverywhereFlag(): boolean {
  const [enabled, setEnabled] = useState(() => isSearchEverywhereEnabled(safeStorage()));

  useEffect(() => {
    const sync = () => setEnabled(isSearchEverywhereEnabled(safeStorage()));
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === SEARCH_EVERYWHERE_FLAG_KEY) sync();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', sync);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', sync);
    };
  }, []);

  return enabled;
}
