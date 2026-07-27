/**
 * Chrome-cmd+F-style highlighting of a search query inside the rendered chat.
 *
 * Highlighting happens against the committed DOM rather than by rewriting
 * message content: assistant text goes through ReactMarkdown plus a syntax
 * highlighter that shreds source strings into nested spans, so a match commonly
 * straddles several text nodes and no single string holds it.
 *
 * It uses the CSS Custom Highlight API (`CSS.highlights` + `::highlight()`)
 * rather than wrapping matches in `<mark>` elements. Wrapping would mutate DOM
 * that React owns — React's fiber tree keeps references to the exact text nodes
 * it created, so splitting or replacing them can make later updates to that text
 * silently vanish. Ranges style the same text with zero mutation, so React's
 * view of the tree stays intact.
 *
 * Where the API is unavailable this degrades to no term highlighting; the
 * whole-message `search-highlight-flash` outline still shows which message
 * matched.
 */

/** Registry names, referenced by `::highlight(...)` rules in index.css. */
export const SEARCH_HIGHLIGHT_NAME = 'search-term';
export const SEARCH_HIGHLIGHT_CURRENT_NAME = 'search-term-current';

/** Tags whose text is markup/scaffolding rather than transcript content. */
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT']);

/**
 * A collapsed disclosure section (`Collapsible`) keeps its children in the DOM
 * but clips them to zero height, so a highlight inside one paints correctly and
 * is still completely invisible.
 */
const CLOSED_CONTENT_SELECTOR = '[data-collapsible-content][data-state="closed"]';

/**
 * A closed command row (`BashCommandDisplay`) is the harder case: it omits its
 * output from the DOM entirely rather than clipping it. Nothing can be tested
 * for a match beforehand, so these open unconditionally — the enclosing message
 * is already known to match, and the output is the likeliest place the term
 * actually lives.
 */
const HIDDEN_OUTPUT_SELECTOR = '[data-output-toggle][data-state="closed"]';

/**
 * Ceiling on how many sections one navigation opens. A short query can appear in
 * every tool block of a message; the point is to reveal the match the user
 * clicked, not to unfold the entire turn.
 */
const MAX_AUTO_EXPANDED_SECTIONS = 12;

/**
 * Open the collapsed sections inside `element` whose text contains `query`, so
 * the highlight lands somewhere the user can actually see.
 *
 * Returns how many were opened — non-zero means the caller should let the
 * grid-rows transition settle before measuring ranges for scrolling.
 */
export function expandCollapsedMatches(element: Element | null | undefined, query: string): number {
  if (!element) return 0;

  const needle = query.trim().toLowerCase();
  if (!needle) return 0;

  // Collected before any clicking: `data-state` only flips once React re-renders,
  // so the list would be unreliable if it were re-queried mid-loop.
  const closedSections = Array.from(element.querySelectorAll(CLOSED_CONTENT_SELECTOR));
  const hiddenOutputs = Array.from(element.querySelectorAll(HIDDEN_OUTPUT_SELECTOR));
  let expanded = 0;

  // Command output first: it's absent from the DOM, so a match there is
  // invisible to the text test the clipped sections below rely on.
  for (const toggle of hiddenOutputs) {
    if (expanded >= MAX_AUTO_EXPANDED_SECTIONS) break;
    if (!(toggle instanceof HTMLElement)) continue;

    toggle.click();
    expanded += 1;
  }

  // Document order, so an outer section opens before the ones nested inside it.
  for (const content of closedSections) {
    if (expanded >= MAX_AUTO_EXPANDED_SECTIONS) break;
    if (!(content.textContent || '').toLowerCase().includes(needle)) continue;

    const trigger = findOwnTrigger(content);
    if (!trigger) continue;

    trigger.click();
    expanded += 1;
  }

  return expanded;
}

/**
 * The trigger that toggles `content`'s own section — not one belonging to a
 * collapsible nested inside it.
 */
function findOwnTrigger(content: Element): HTMLElement | null {
  const root = content.closest('[data-collapsible-root]');
  if (!root) return null;

  for (const candidate of root.querySelectorAll('[data-collapsible-trigger]')) {
    if (candidate.closest('[data-collapsible-root]') === root && candidate instanceof HTMLElement) {
      return candidate;
    }
  }

  return null;
}

/** Is this range inside a section that's still clipped to zero height? */
function isRangeClipped(range: Range): boolean {
  const start = range.startContainer;
  const element = start instanceof Element ? start : start.parentElement;
  return Boolean(element?.closest(CLOSED_CONTENT_SELECTOR));
}

type HighlightRegistryLike = {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
};

type HighlightConstructor = new (...ranges: Range[]) => unknown;

/**
 * The API is recent enough that the constructor and registry are probed at
 * runtime instead of assumed.
 */
function getHighlightApi(): { registry: HighlightRegistryLike; Highlight: HighlightConstructor } | null {
  if (typeof CSS === 'undefined') return null;

  const registry = (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
  const HighlightCtor = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight;
  if (!registry || typeof HighlightCtor !== 'function') return null;

  return { registry, Highlight: HighlightCtor };
}

/** Remove any term highlights currently registered. Safe to call repeatedly. */
export function clearSearchHighlights(): void {
  const api = getHighlightApi();
  if (!api) return;

  api.registry.delete(SEARCH_HIGHLIGHT_NAME);
  api.registry.delete(SEARCH_HIGHLIGHT_CURRENT_NAME);
}

/**
 * Highlight every case-insensitive occurrence of `query` inside `element`,
 * emphasizing the first one as the "current" match the way Chrome does.
 *
 * Returns the matched ranges in document order — empty when nothing matched or
 * the browser lacks the API — so the caller can scroll the first one into view.
 */
export function highlightQueryInElement(element: Element | null | undefined, query: string): Range[] {
  clearSearchHighlights();

  const api = getHighlightApi();
  if (!api || !element) return [];

  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  // Flatten the subtree's text, tracking each node's offset, so a match that
  // spans several nodes (inline code, syntax-highlighted spans) still resolves
  // to one Range across them.
  const nodes: { node: Text; start: number }[] = [];
  let flattened = '';

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parentTag = node.parentElement?.tagName;
      if (parentTag && SKIPPED_TAGS.has(parentTag)) return NodeFilter.FILTER_REJECT;
      return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    nodes.push({ node: textNode, start: flattened.length });
    flattened += textNode.nodeValue ?? '';
  }

  if (!flattened) return [];

  const haystack = flattened.toLowerCase();
  const ranges: Range[] = [];

  for (let cursor = haystack.indexOf(needle); cursor !== -1; cursor = haystack.indexOf(needle, cursor + needle.length)) {
    const range = createRange(nodes, cursor, cursor + needle.length);
    if (range) ranges.push(range);
  }

  if (ranges.length === 0) return [];

  // Prefer a match the user can see: any still-collapsed section clips its
  // contents to zero height, so treating its first match as "current" would
  // scroll to something invisible.
  const currentIndex = Math.max(ranges.findIndex((range) => !isRangeClipped(range)), 0);
  const current = ranges[currentIndex];
  const rest = ranges.filter((_, index) => index !== currentIndex);

  // Two registries so the navigated-to match can be styled distinctly, like
  // Chrome's orange active match against yellow for the rest.
  api.registry.set(SEARCH_HIGHLIGHT_CURRENT_NAME, new api.Highlight(current));
  if (rest.length > 0) {
    api.registry.set(SEARCH_HIGHLIGHT_NAME, new api.Highlight(...rest));
  }

  // Current first, so callers scrolling `ranges[0]` land on the active match.
  return [current, ...rest];
}

/**
 * Turn a span of the flattened text into a DOM Range by locating the text nodes
 * that hold its start and end offsets.
 */
function createRange(nodes: { node: Text; start: number }[], start: number, end: number): Range | null {
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  for (const { node, start: nodeStart } of nodes) {
    const length = node.nodeValue?.length ?? 0;
    const nodeEnd = nodeStart + length;

    if (!startNode && start >= nodeStart && start < nodeEnd) {
      startNode = node;
      startOffset = start - nodeStart;
    }
    // `end` is exclusive, so a match ending exactly on a node boundary belongs
    // to that node rather than the next one.
    if (end > nodeStart && end <= nodeEnd) {
      endNode = node;
      endOffset = end - nodeStart;
      break;
    }
  }

  if (!startNode || !endNode) return null;

  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

/**
 * Scroll a highlighted range into view. Ranges have no `scrollIntoView`, so this
 * scrolls the container by the offset between the range and the viewport centre
 * — needed because a single tool result can be taller than the viewport, leaving
 * the matched term offscreen even when its message is "centered".
 */
export function scrollRangeIntoView(range: Range, container: HTMLElement): void {
  // A clipped range still reports the layout rect of its (invisible) text, so
  // centering on it would scroll to blank space. Fall back to the collapsed
  // section's own header, which is on screen and next to the match.
  if (isRangeClipped(range)) {
    const start = range.startContainer;
    const element = start instanceof Element ? start : start.parentElement;
    const section = element?.closest(CLOSED_CONTENT_SELECTOR)?.closest('[data-collapsible-root]');
    section?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }

  const rangeRect = range.getBoundingClientRect();
  // A collapsed/undisplayed range reports zeros; nothing sensible to scroll to.
  if (rangeRect.height === 0 && rangeRect.width === 0) return;

  const containerRect = container.getBoundingClientRect();
  const rangeCenter = rangeRect.top + rangeRect.height / 2;
  const containerCenter = containerRect.top + containerRect.height / 2;

  container.scrollBy({ top: rangeCenter - containerCenter, behavior: 'smooth' });
}
