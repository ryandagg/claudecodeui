// Classifies strings that surface in chat markdown — link hrefs, link text, and
// inline code — as either a web hyperlink or a workspace file reference. The two
// are handled very differently: a hyperlink opens in the browser, a file path
// opens in the in-app editor (plain click) or VS Code (⌘/Ctrl-click). Getting
// this wrong is what made URLs like `https://example.com` try to open in VS Code
// — a URL's `//` reads as a path separator unless it is excluded first.

// Strip a trailing `:line` / `:line:col` suffix (e.g. `src/foo.ts:130`).
export const stripLineSuffix = (value: string): string => value.replace(/:\d+(?::\d+)?$/, '');

// A hyperlink to the wider web (or an in-page `#anchor`) keeps normal browser
// navigation and must never be mistaken for a workspace file path. The reliable
// signals are a URL scheme with an authority (`https://`, `ftp://`, …), the
// slash-less schemes (`mailto:` / `tel:` / `data:`), a bare `www.` host, or a
// `#` fragment. Matching `scheme://` rather than a bare `scheme:` is deliberate:
// a Windows path like `C:\Users\me` also begins with `letter:` and must stay a
// file path.
export const looksLikeUrl = (value?: string): boolean => {
  if (!value) {
    return false;
  }
  const cleaned = value.trim();
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) ||
    /^(mailto:|tel:|data:)/i.test(cleaned) ||
    /^www\./i.test(cleaned) ||
    cleaned.startsWith('#')
  );
};

// A usable file path contains a separator or a filename with an extension — but
// is never a URL. URLs are ruled out up front so their `//` is not mistaken for
// a path separator.
export const looksLikeFilePath = (value?: string): value is string => {
  if (!value) {
    return false;
  }
  const cleaned = stripLineSuffix(value.trim());
  if (!cleaned || looksLikeUrl(cleaned)) {
    return false;
  }
  return /[\\/]/.test(cleaned) || /\.[a-z0-9]+$/i.test(cleaned);
};

// Inline code often IS a file path (`src/foo.ts`, `server/index.js:42`), but it
// is just as often prose-y identifiers (`array.map`, `Math.random`, `--flag`)
// or a backticked URL. Only linkify inline code that carries a path separator,
// no whitespace, and is not a URL, so dotted method calls, option flags, and
// links stay plain text.
export const inlineCodeLooksLikePath = (value: string): boolean => {
  const cleaned = stripLineSuffix(value.trim());
  if (!cleaned || /\s/.test(cleaned)) {
    return false;
  }
  return /[\\/]/.test(cleaned) && looksLikeFilePath(cleaned);
};
