import { baseColors } from "@/styles/theme";
import type { SessionFindState } from "./find-in-session";

/**
 * Text-level match highlighting for find-in-session via the CSS Custom
 * Highlight API. Ranges are registered against text nodes inside
 * `[data-stream-item-id]` rows, so no React re-render or markdown rewriting is
 * needed. On runtimes without the API (or native), everything degrades to
 * scroll-to-row with no text highlight.
 *
 * `CSS.highlights` is a document-global registry, but stream viewports are not:
 * retained tabs and split panes keep several mounted at once, all of them
 * re-running their highlight pass whenever their own agent streams. Each
 * viewport therefore acquires its own highlight slot and only ever writes or
 * deletes the two names belonging to that slot, so a background pane cannot
 * clear the foreground pane's highlights and two open find bars do not
 * overwrite each other. Slots are pooled on release, so the number of
 * registered `::highlight()` rules stays bounded by peak concurrent viewports.
 */

const HIGHLIGHT_STYLE_ELEMENT_ID = "paseo-session-find-highlight-style";

export interface SessionFindHighlightOwner {
  readonly slot: number;
  readonly matchName: string;
  readonly activeName: string;
}

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

interface HighlightConstructor {
  new (...ranges: Range[]): unknown;
}

const releasedSlots: number[] = [];
const slotsWithStyles = new Set<number>();
let nextSlot = 0;

function getHighlightSupport(): {
  registry: HighlightRegistry;
  Highlight: HighlightConstructor;
} | null {
  if (typeof document === "undefined" || typeof CSS === "undefined") {
    return null;
  }
  const css = CSS as unknown as { highlights?: HighlightRegistry };
  const highlightCtor = (globalThis as { Highlight?: HighlightConstructor }).Highlight;
  if (!css.highlights || typeof highlightCtor !== "function") {
    return null;
  }
  return { registry: css.highlights, Highlight: highlightCtor };
}

function ensureSlotStyles(owner: SessionFindHighlightOwner): void {
  if (slotsWithStyles.has(owner.slot)) {
    return;
  }
  let style = document.getElementById(HIGHLIGHT_STYLE_ELEMENT_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = HIGHLIGHT_STYLE_ELEMENT_ID;
    document.head.appendChild(style);
  }
  // Alpha-tinted palette values read on both light and dark surfaces; the
  // active occurrence gets a solid fill so it stands out among matches.
  style.textContent += [
    `::highlight(${owner.matchName}) { background-color: ${baseColors.amber[500]}4d; }`,
    `::highlight(${owner.activeName}) { background-color: ${baseColors.amber[500]}; color: ${baseColors.zinc[900]}; }`,
    "",
  ].join("\n");
  slotsWithStyles.add(owner.slot);
}

export function acquireSessionFindHighlightOwner(): SessionFindHighlightOwner {
  const slot = releasedSlots.pop() ?? nextSlot++;
  return {
    slot,
    matchName: `paseo-session-find-match-${slot}`,
    activeName: `paseo-session-find-active-${slot}`,
  };
}

export function releaseSessionFindHighlightOwner(owner: SessionFindHighlightOwner): void {
  clearSessionFindHighlights(owner);
  if (!releasedSlots.includes(owner.slot)) {
    releasedSlots.push(owner.slot);
  }
}

function collectTextNodes(root: Element): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
}

interface RowTextSegment {
  node: Text;
  /** Offset of this node's text within the row's concatenated text. */
  start: number;
  end: number;
}

interface RowText {
  lowerCaseText: string;
  segments: RowTextSegment[];
}

/**
 * Flattens a row's text nodes into one searchable string plus the offset map
 * needed to turn a match back into a DOM range.
 *
 * Searching each text node separately would miss any occurrence the renderer
 * split across nodes — which is the common case inside highlighted code blocks,
 * where a contiguous source string becomes one span per syntax token. Ranges may
 * span nodes, so matching over the concatenation and mapping the endpoints back
 * finds those occurrences too.
 */
function buildRowText(row: Element): RowText {
  const segments: RowTextSegment[] = [];
  let text = "";
  for (const node of collectTextNodes(row)) {
    const content = node.textContent;
    if (!content) {
      continue;
    }
    segments.push({ node, start: text.length, end: text.length + content.length });
    text += content;
  }
  return { lowerCaseText: text.toLowerCase(), segments };
}

/** Maps a start offset in the concatenated text back to a node position. */
function resolveStart(
  segments: RowTextSegment[],
  offset: number,
): { node: Text; offset: number } | null {
  const segment = segments.find((candidate) => offset >= candidate.start && offset < candidate.end);
  return segment ? { node: segment.node, offset: offset - segment.start } : null;
}

/** Maps an exclusive end offset back to a node position. */
function resolveEnd(
  segments: RowTextSegment[],
  offset: number,
): { node: Text; offset: number } | null {
  const segment = segments.find((candidate) => offset > candidate.start && offset <= candidate.end);
  return segment ? { node: segment.node, offset: offset - segment.start } : null;
}

function collectRowRanges(row: Element, needle: string): Range[] {
  const { lowerCaseText, segments } = buildRowText(row);
  const ranges: Range[] = [];
  let searchFrom = 0;
  while (true) {
    const foundAt = lowerCaseText.indexOf(needle, searchFrom);
    if (foundAt < 0) {
      break;
    }
    searchFrom = foundAt + needle.length;
    const start = resolveStart(segments, foundAt);
    const end = resolveEnd(segments, foundAt + needle.length);
    if (!start || !end) {
      continue;
    }
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    ranges.push(range);
  }
  return ranges;
}

/**
 * Splits the active row's DOM ranges into active and non-active occurrences.
 *
 * The match model enumerates occurrences in an item's source text, while these
 * ranges are enumerated over the row's rendered text. Those two sequences agree
 * for ordinary prose but cannot be assumed to: the model sees markdown syntax
 * the reader never does, rendered chrome inside a row can contribute a range the
 * model never saw, and concatenating the row's text can join across a visual
 * block boundary. Indexing blindly would then emphasize an unrelated occurrence,
 * so the ordinal is trusted only when the two enumerations demonstrably agree on
 * the row's occurrence count. Otherwise every occurrence in the row is
 * emphasized — the row is where navigation scrolled to, so "your match is one of
 * these" stays true.
 */
function partitionActiveRowRanges(
  rowRanges: Range[],
  find: SessionFindState,
): { active: Range[]; match: Range[] } {
  const enumerationsAgree = rowRanges.length === find.activeItemOccurrenceCount;
  if (!enumerationsAgree) {
    return { active: rowRanges, match: [] };
  }
  const active: Range[] = [];
  const match: Range[] = [];
  rowRanges.forEach((range, occurrenceIndex) => {
    if (occurrenceIndex === find.activeOccurrenceIndex) {
      active.push(range);
    } else {
      match.push(range);
    }
  });
  return { active, match };
}

/**
 * Re-scans the mounted rows inside `container` and replaces the highlight
 * ranges registered under `owner`'s slot.
 */
export function applySessionFindHighlights(input: {
  owner: SessionFindHighlightOwner;
  container: HTMLElement;
  find: SessionFindState;
}): void {
  const support = getHighlightSupport();
  if (!support) {
    return;
  }
  ensureSlotStyles(input.owner);

  const needle = input.find.query.toLowerCase();
  const matchRanges: Range[] = [];
  const activeRanges: Range[] = [];
  if (needle.length > 0) {
    const rows = input.container.querySelectorAll("[data-stream-item-id]");
    for (const row of rows) {
      const rowRanges = collectRowRanges(row, needle);
      if (row.getAttribute("data-stream-item-id") !== input.find.activeItemId) {
        matchRanges.push(...rowRanges);
        continue;
      }
      const partitioned = partitionActiveRowRanges(rowRanges, input.find);
      activeRanges.push(...partitioned.active);
      matchRanges.push(...partitioned.match);
    }
  }

  support.registry.set(input.owner.matchName, new support.Highlight(...matchRanges));
  support.registry.set(input.owner.activeName, new support.Highlight(...activeRanges));
}

export function clearSessionFindHighlights(owner: SessionFindHighlightOwner): void {
  const support = getHighlightSupport();
  if (!support) {
    return;
  }
  support.registry.delete(owner.matchName);
  support.registry.delete(owner.activeName);
}
