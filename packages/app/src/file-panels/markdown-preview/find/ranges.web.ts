export const MATCH_STATUS_LIMIT = 10_000;

const BLOCKS = ["p", "pre", "li", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"]
  .flatMap((tag) => [tag, `[data-paseo-markdown-tag="${tag}"]`])
  .join(",");
const LINE_BREAKS = "br";
const IGNORED =
  '[data-paseo-markdown-ignore="true"], [aria-hidden="true"], button, [role="button"], svg, script, style';

export interface MarkdownPreviewMatchResult {
  ranges: Range[];
  limited: boolean;
}

function escapeLiteralPattern(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderedTextGroups(frame: HTMLElement): Text[][] {
  const groups: Text[][] = [];
  let group: { block: Element; texts: Text[] } | undefined;
  const walker = document.createTreeWalker(frame, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node instanceof Element) {
      if (node.matches(BLOCKS) || node.matches(LINE_BREAKS)) group = undefined;
      continue;
    }
    if (!(node instanceof Text) || !node.data || node.parentElement?.closest(IGNORED)) continue;
    const block = node.parentElement?.closest(BLOCKS) ?? frame;
    if (group?.block !== block) {
      group = { block, texts: [] };
      groups.push(group.texts);
    }
    group.texts.push(node);
  }
  return groups;
}

/**
 * Literal case-insensitive matches across rendered Markdown blocks and frontmatter cells,
 * preserving exact UTF-16 DOM Text offsets and stopping at `limit` with `limited: true`.
 */
export function findMarkdownPreviewMatches(
  frame: HTMLElement | null,
  query: string,
  limit = MATCH_STATUS_LIMIT,
): MarkdownPreviewMatchResult {
  if (!frame || !query) return { ranges: [], limited: false };
  const expression = new RegExp(escapeLiteralPattern(query), "giu");
  const ranges: Range[] = [];
  for (const texts of renderedTextGroups(frame)) {
    const points = texts.map((node) => ({ node, start: 0, end: 0 }));
    let text = "";
    for (const point of points) {
      point.start = text.length;
      text += point.node.data;
      point.end = text.length;
    }
    if (!text) continue;
    for (const match of text.matchAll(expression)) {
      if (match[0].length === 0) continue;
      if (ranges.length === limit) {
        return { ranges, limited: true };
      }
      const startOffset = match.index;
      const endOffset = startOffset + match[0].length;
      const start = points.find((point) => point.start <= startOffset && point.end > startOffset);
      const end = points.find((point) => point.start < endOffset && point.end >= endOffset);
      if (!start || !end) continue;
      const range = document.createRange();
      range.setStart(start.node, startOffset - start.start);
      range.setEnd(end.node, endOffset - end.start);
      ranges.push(range);
    }
  }
  return { ranges, limited: false };
}

function blockForNode(node: Node, frame: HTMLElement): Element {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(BLOCKS) ?? frame;
}

function rangeSpansMultipleLines(range: Range, frame: HTMLElement): boolean {
  if (blockForNode(range.startContainer, frame) !== blockForNode(range.endContainer, frame)) {
    return true;
  }
  const fragment = range.cloneContents();
  return Boolean(
    fragment.querySelector(BLOCKS) ||
    fragment.querySelector(LINE_BREAKS) ||
    /[\r\n]/.test(fragment.textContent ?? ""),
  );
}

/**
 * Returns the selected single-line string when the user selected rendered text inside
 * the Markdown preview frame; declines empty or multiline selections.
 */
export function selectedSingleLineText(frame: HTMLElement | null): string | null {
  if (!frame || typeof window === "undefined") return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!frame.contains(range.startContainer) || !frame.contains(range.endContainer)) {
    return null;
  }
  if (rangeSpansMultipleLines(range, frame)) return null;
  const text = selection.toString();
  return text && !/[\r\n]/.test(text) ? text : null;
}
