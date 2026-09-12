const BLOCKS = ["p", "pre", "li", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6"]
  .map((tag) => `[data-paseo-markdown-tag="${tag}"]`)
  .join(",");
const IGNORED =
  '[data-paseo-markdown-ignore="true"], [aria-hidden="true"], button, [role="button"], svg, script, style';

/** Local offsets belong to the DOM that supplied the text, never to a host parser. */
export function findRenderedMatches(row: HTMLElement, query: string): Range[] {
  if (!query.trim()) return [];
  const groups = new Map<Element, Text[]>();
  for (const content of row.querySelectorAll<HTMLElement>('[data-message-text="true"]')) {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!(node instanceof Text) || node.parentElement?.closest(IGNORED)) continue;
      const block = node.parentElement?.closest(BLOCKS) ?? content;
      const texts = groups.get(block) ?? [];
      texts.push(node);
      groups.set(block, texts);
    }
  }
  const pattern = query
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const ranges: Range[] = [];
  for (const texts of groups.values()) {
    const points = texts.map((node) => ({ node, start: 0, end: 0 }));
    let text = "";
    for (const point of points) {
      point.start = text.length;
      text += point.node.data;
      point.end = text.length;
    }
    for (const match of text.matchAll(new RegExp(pattern, "giu"))) {
      const start = points.find((point) => point.start <= match.index && point.end > match.index);
      const endOffset = match.index + match[0].length;
      const end = points.find((point) => point.start < endOffset && point.end >= endOffset);
      if (!start || !end) continue;
      const range = document.createRange();
      range.setStart(start.node, match.index - start.start);
      range.setEnd(end.node, endOffset - end.start);
      ranges.push(range);
    }
  }
  return ranges;
}
