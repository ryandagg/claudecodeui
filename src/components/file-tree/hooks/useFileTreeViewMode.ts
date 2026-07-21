import { useCallback, useEffect, useState } from 'react';

import { useSettings } from '../../../contexts/SettingsContext';
import {
  FILE_TREE_DEFAULT_VIEW_MODE,
  FILE_TREE_VIEW_MODES,
  FILE_TREE_VIEW_MODE_STORAGE_KEY,
} from '../constants/constants';
import type { FileTreeViewMode } from '../types/types';

type UseFileTreeViewModeResult = {
  viewMode: FileTreeViewMode;
  changeViewMode: (mode: FileTreeViewMode) => void;
};

const parseViewMode = (saved: string | null): FileTreeViewMode => (
  saved && FILE_TREE_VIEW_MODES.includes(saved as FileTreeViewMode)
    ? (saved as FileTreeViewMode)
    : FILE_TREE_DEFAULT_VIEW_MODE
);

export function useFileTreeViewMode(): UseFileTreeViewModeResult {
  const { getSetting, setSetting, ready } = useSettings();

  const [viewMode, setViewMode] = useState<FileTreeViewMode>(() => (
    parseViewMode(getSetting(FILE_TREE_VIEW_MODE_STORAGE_KEY))
  ));

  useEffect(() => {
    if (!ready) {
      return;
    }
    setViewMode(parseViewMode(getSetting(FILE_TREE_VIEW_MODE_STORAGE_KEY)));
  }, [ready, getSetting]);

  const changeViewMode = useCallback((mode: FileTreeViewMode) => {
    setViewMode(mode);
    setSetting(FILE_TREE_VIEW_MODE_STORAGE_KEY, mode);
  }, [setSetting]);

  return {
    viewMode,
    changeViewMode,
  };
}

