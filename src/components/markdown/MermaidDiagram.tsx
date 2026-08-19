import React, { useEffect, useId, useRef, useState } from 'react';

import { useTheme } from '../../contexts/ThemeContext';
import { copyTextToClipboard } from '../../utils/clipboard';

import { getMermaidId, getMermaidInitConfig } from './mermaidConfig';

// Mermaid is a large dependency, so it is loaded lazily the first time a
// diagram appears and cached thereafter — it never enters the initial bundle.
type MermaidModule = typeof import('mermaid')['default'];
let mermaidModulePromise: Promise<MermaidModule> | null = null;
function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid').then((mod) => mod.default);
  }
  return mermaidModulePromise;
}

// While a message streams, the fenced block arrives a token at a time and is
// invalid until the closing fence lands. Debouncing re-renders avoids parsing
// every intermediate state; the first render runs immediately so already
// complete diagrams don't flash their source.
const RENDER_DEBOUNCE_MS = 200;

type MermaidDiagramProps = {
  code: string;
  // The syntax-highlighted code block the caller would otherwise render. Shown
  // while the diagram is still streaming/invalid and if rendering fails, so the
  // source is never lost.
  fallback: React.ReactNode;
};

/**
 * Renders a ```mermaid fenced block as an SVG diagram. Invalid or incomplete
 * source falls back to the plain code block, so a half-streamed or malformed
 * diagram degrades to readable text instead of an error.
 */
export function MermaidDiagram({ code, fallback }: MermaidDiagramProps) {
  const { isDarkMode } = useTheme();
  const reactId = useId();
  const [svg, setSvg] = useState<string | null>(null);
  const [renderError, setRenderError] = useState(false);
  const [copied, setCopied] = useState(false);
  const firstRunRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    const trimmed = code.trim();
    if (!trimmed) {
      setSvg(null);
      setRenderError(false);
      return;
    }

    const delay = firstRunRef.current ? 0 : RENDER_DEBOUNCE_MS;
    firstRunRef.current = false;

    const timer = setTimeout(async () => {
      try {
        const mermaid = await loadMermaid();
        if (cancelled) {
          return;
        }
        mermaid.initialize(getMermaidInitConfig(isDarkMode));
        // Gate on parse validity: during streaming the source is incomplete, so
        // treat "won't parse" as "not ready yet" and keep showing the source
        // rather than surfacing an error.
        const parsed = await mermaid.parse(trimmed, { suppressErrors: true });
        if (cancelled) {
          return;
        }
        if (!parsed) {
          setSvg(null);
          setRenderError(false);
          return;
        }
        const { svg: rendered } = await mermaid.render(getMermaidId(reactId), trimmed);
        if (cancelled) {
          return;
        }
        setSvg(rendered);
        setRenderError(false);
      } catch {
        // Parsed but failed to render — a genuinely malformed diagram. Surface
        // it so the author knows, and fall back to the source below.
        if (!cancelled) {
          setSvg(null);
          setRenderError(true);
        }
      }
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, isDarkMode, reactId]);

  // No diagram yet: still streaming, incomplete, or failed to render. Show the
  // source, with a hint when a completed diagram was actually malformed.
  if (!svg) {
    if (renderError) {
      return (
        <div className="my-2">
          <div className="mb-1 text-xs text-red-500 dark:text-red-400">
            Could not render mermaid diagram — showing source.
          </div>
          {fallback}
        </div>
      );
    }
    return <>{fallback}</>;
  }

  const handleCopy = () => {
    copyTextToClipboard(code).then((success) => {
      if (success) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    });
  };

  return (
    <div className="group relative my-2">
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-2 top-2 z-10 rounded-md border border-gray-300 bg-white/80 px-2 py-1 text-xs text-gray-700 opacity-0 transition-opacity hover:bg-white focus:opacity-100 active:opacity-100 group-hover:opacity-100 dark:border-gray-600 dark:bg-gray-800/80 dark:text-gray-200 dark:hover:bg-gray-800"
        title={copied ? 'Copied!' : 'Copy diagram source'}
        aria-label={copied ? 'Copied!' : 'Copy diagram source'}
      >
        {copied ? 'Copied!' : 'Copy source'}
      </button>
      <div
        role="img"
        aria-label="Mermaid diagram"
        className="flex justify-center overflow-x-auto rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900 [&_svg]:h-auto [&_svg]:max-w-full"
        // Safe: mermaid renders with securityLevel 'strict', which routes markup
        // through DOMPurify and strips scripts/handlers before we inject it.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}
