const BLOCKS = ["p", "pre", "li", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6"]
  .flatMap((tag) => [tag, `[data-paseo-markdown-tag="${tag}"]`])
  .join(",");
const IGNORED =
  '[data-paseo-markdown-ignore="true"], [aria-hidden="true"], button, [role="button"], svg, script, style';

export interface RenderedMatchOptions {
  /**
   * Also treat every div (a React Native View or Text) as a block, for content whose
   * structure comes from React Native rather than from Markdown tags.
   */
  divBlocks?: boolean;
  /** Skip text the user cannot see, for content that keeps hidden nodes mounted. */
  visibleOnly?: boolean;
}

function renderedTextGroups(
  contents: Iterable<HTMLElement>,
  { divBlocks = false, visibleOnly = false }: RenderedMatchOptions,
): Text[][] {
  const groups: Text[][] = [];
  const blocks = divBlocks ? `${BLOCKS},div` : BLOCKS;
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
        visibleOnly &&
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

/**
 * Case-insensitive occurrences of `query` in rendered text, in document order. A match
 * never crosses a block, and any run of whitespace in the query matches any run in the
 * text. Local offsets belong to the DOM that supplied the text, never to a host parser.
 */
export function findRenderedTextMatches(
  contents: Iterable<HTMLElement>,
  query: string,
  options: RenderedMatchOptions = {},
): Range[] {
  if (!query.trim()) return [];
  const pattern = query
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const ranges: Range[] = [];
  for (const texts of renderedTextGroups(contents, options)) {
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
