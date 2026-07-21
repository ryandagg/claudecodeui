import { useCallback, useEffect, useRef, useState } from 'react';

import { useSettings } from '../contexts/SettingsContext';

const STORAGE_KEY = 'sidebar-width';
const DEFAULT_WIDTH = 288;
const MIN_WIDTH = 220;
const MAX_WIDTH = 560;

const clampWidth = (value: number): number => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value));

export function useResizableSidebar() {
  const { getSetting, setSetting } = useSettings();

  const [width, setWidth] = useState<number>(() => {
    const raw = getSetting(STORAGE_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_WIDTH;
  });
  const [isDragging, setIsDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  const onResizeStart = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = widthRef.current;
    setIsDragging(true);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setWidth(clampWidth(startWidth + (moveEvent.clientX - startX)));
    };

    const handlePointerUp = () => {
      setIsDragging(false);
      setSetting(STORAGE_KEY, String(widthRef.current));
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }, [setSetting]);

  useEffect(() => {
    if (!isDragging) return;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };
  }, [isDragging]);

  return { width, isDragging, onResizeStart };
}
