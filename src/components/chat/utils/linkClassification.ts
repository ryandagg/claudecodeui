// Classifies strings that surface in chat markdown — link hrefs, link text, and
// inline code — as either a web hyperlink or a workspace file reference. The two
// are handled very differently: a hyperlink opens in the browser, a file path
// opens in the in-app editor (plain click) or VS Code (⌘/Ctrl-click). Getting
// this wrong is what made URLs like `https://example.com` try to open in VS Code
// — a URL's `//` reads as a path separator unless it is excluded first.

import { LinkifyIt } from 'linkify-it';

import { stripLineSuffix } from '../../../utils/filePaths';

// URL detection is delegated to linkify-it (the link engine behind markdown-it)
// rather than hand-rolled regexes. Its "fuzzy" bare-domain and bare-email
// heuristics are turned off on purpose: with them on, a source file whose
// extension happens to be a country-code TLD (`foo.ts`, `index.rs`, `main.sh`)
// would be mistaken for a link. Two schemes linkify-it does not ship by default
// — `tel:` and `data:` — are registered so those URIs are still recognised.
const linkify = new LinkifyIt({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
linkify.add('tel:', {
  validate: (text, pos) => {
    const match = /^[+()\-.\s0-9]{3,}/.exec(text.slice(pos));
    return match ? match[0].length : 0;
  },
});
linkify.add('data:', {
  validate: (text, pos) => text.slice(pos).length,
});

// A hyperlink to the wider web (or an in-page `#anchor`) keeps normal browser
// navigation and must never be mistaken for a workspace file path. linkify-it
// recognises scheme URLs (`https://…`, `mailto:…`, `tel:…`, …) anchored at the
// start of the string; on top of that we treat a bare `www.` host and a `#`
// fragment as browser links too, matching how GitHub-flavoured markdown and the
// browser themselves resolve them. Anchoring at the start keeps a Windows path
// like `C:\Users\me` — whose `C:` is not a real scheme — a file path.
export const looksLikeUrl = (value?: string): boolean => {
  if (!value) {
    return false;
  }
  const cleaned = value.trim();
  if (!cleaned) {
    return false;
  }
  if (cleaned.startsWith('#') || /^www\./i.test(cleaned)) {
    return true;
  }
  return linkify.matchAtStart(cleaned) !== null;
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
