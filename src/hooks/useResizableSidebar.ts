import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'sidebar-width';
// Bounds chosen so the panel can't collapse past usability or crowd out the
// chat pane. The default matches the legacy fixed width (Tailwind w-72 = 18rem).
const DEFAULT_WIDTH = 288;
const MIN_WIDTH = 220;
const MAX_WIDTH = 560;

const clampWidth = (value: number): number => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value));

const readStoredWidth = (): number => {
  if (typeof window === 'undefined') {
    return DEFAULT_WIDTH;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_WIDTH;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
};

/**
 * Drag-to-resize state for the desktop sidebar.
 *
 * Returns the current pixel width, an `isDragging` flag (for cursor/selection
 * styling), and a pointer-down handler to attach to the drag handle. Width is
 * clamped to [MIN_WIDTH, MAX_WIDTH] and persisted to localStorage so it
 * survives reloads. Mobile callers should simply ignore this — the mobile
 * sidebar is an overlay with its own width.
 */
export function useResizableSidebar() {
  const [width, setWidth] = useState<number>(readStoredWidth);
  const [isDragging, setIsDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  const onResizeStart = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = widthRef.current;
    setIsDragging(true);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      // Handle sits on the sidebar's right edge, so dragging right widens it.
      setWidth(clampWidth(startWidth + (moveEvent.clientX - startX)));
    };

    const handlePointerUp = () => {
      setIsDragging(false);
      try {
        window.localStorage.setItem(STORAGE_KEY, String(widthRef.current));
      } catch {
        // Width still applies for this session even if persistence fails.
      }
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }, []);

  // While dragging, suppress text selection and force the resize cursor
  // globally so a fast drag that outruns the handle still feels right.
  useEffect(() => {
    if (!isDragging) {
      return;
    }
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
