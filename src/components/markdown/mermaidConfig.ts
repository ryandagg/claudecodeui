import type { MermaidConfig } from 'mermaid';

export type MermaidTheme = 'dark' | 'default';

/**
 * react-markdown wraps every fenced block in a `<pre>`, and the `.prose`
 * typography styles give that `<pre>` a dark background even in light mode. For
 * a rendered diagram (which has its own light/dark background) that dark wrapper
 * shows as a box around the diagram, so callers detect a mermaid `<pre>` via
 * this helper and render it without the prose styling.
 *
 * `node` is the hast element react-markdown passes to a `pre` component; its
 * first child is the `<code>` carrying the `language-mermaid` class.
 */
export function isMermaidCodeNode(node: unknown): boolean {
  const child = (node as { children?: Array<{ tagName?: string; properties?: { className?: unknown } }> })
    ?.children?.[0];
  if (!child || child.tagName !== 'code') {
    return false;
  }
  const className = child.properties?.className;
  const classes = Array.isArray(className)
    ? className
    : typeof className === 'string'
      ? className.split(/\s+/)
      : [];
  return classes.includes('language-mermaid');
}

/**
 * Mermaid renders in whichever theme matches the app's light/dark mode. The
 * built-in `default` theme reads well on light backgrounds; `dark` on dark.
 */
export function getMermaidTheme(isDarkMode: boolean): MermaidTheme {
  return isDarkMode ? 'dark' : 'default';
}

/**
 * Mermaid uses the render id to build DOM element ids and CSS selectors, so it
 * has to be a valid CSS identifier. React's `useId()` yields values like
 * `:r7:` — the colons break selector parsing and make mermaid throw — so strip
 * everything that isn't a safe id character before handing it over.
 */
export function getMermaidId(seed: string): string {
  const cleaned = (seed || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return `mermaid-${cleaned || 'diagram'}`;
}

/**
 * `securityLevel: 'strict'` (mermaid's default) routes rendered markup through
 * DOMPurify and disables click handlers / inline scripts — the right posture
 * for diagrams whose source comes from model output or pasted files.
 */
export function getMermaidInitConfig(isDarkMode: boolean): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: getMermaidTheme(isDarkMode),
    // Leave fontFamily at mermaid's default: it measures label box widths with
    // that font, so inheriting a different (e.g. monospace) font from the page
    // makes labels overflow and clip. Matching measurement to render avoids that.
  };
}
