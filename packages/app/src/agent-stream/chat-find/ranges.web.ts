const BLOCKS = ["p", "pre", "li", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6"]
  .flatMap((tag) => [tag, `[data-paseo-markdown-tag="${tag}"]`])
  .join(",");
const IGNORED =
  '[data-paseo-markdown-ignore="true"], [aria-hidden="true"], button, [role="button"], svg, script, style';

/** Rendered rows carrying a source message identity, in reading order. */
export function findMessageRows(root: HTMLElement | null, messageId: string): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`),
  );
}

/** Occurrences in one message, ordered by row and then by position inside the row. */
export function findMessageMatches(
  root: HTMLElement | null,
  messageId: string,
  query: string,
): Range[] {
  return findMessageRows(root, messageId).flatMap((row) => findRenderedMatches(row, query));
}

function renderedTextGroups(row: HTMLElement): Text[][] {
  const groups: Text[][] = [];
  // A plugin renderer owns the DOM of the message it replaced and sets no markers, so the
  // whole row is searched and each div (a React Native View or Text) bounds a match.
  const pluginRow = row.dataset.pluginRow === "true";
  const blocks = pluginRow ? `${BLOCKS},div` : BLOCKS;
  const contents = pluginRow
    ? [row]
    : row.querySelectorAll<HTMLElement>('[data-message-text="true"]');
  for (const content of contents) {
    let group: { block: Element; texts: Text[] } | undefined;
    const walker = document.createTreeWalker(
      content,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    );
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node instanceof Element) {
        // Even an empty nested block separates the text before and after it.
        if (node.matches(blocks)) group = undefined;
        continue;
      }
      if (!(node instanceof Text) || node.parentElement?.closest(IGNORED)) continue;
      if (
        pluginRow &&
        !node.parentElement?.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      )
        continue;
      const block = node.parentElement?.closest(blocks) ?? content;
      if (group?.block !== block) {
        group = { block, texts: [] };
        groups.push(group.texts);
      }
      group.texts.push(node);
    }
  }
  return groups;
}

/** Local offsets belong to the DOM that supplied the text, never to a host parser. */
export function findRenderedMatches(row: HTMLElement, query: string): Range[] {
  if (!query.trim()) return [];
  const pattern = query
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const ranges: Range[] = [];
  for (const texts of renderedTextGroups(row)) {
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
