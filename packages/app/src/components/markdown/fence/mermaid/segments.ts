import { fromMarkdown } from "mdast-util-from-markdown";
import type { RootContent } from "mdast";
import { referenceDefinitionSource } from "../../definitions";

interface Segment {
  kind: "markdown" | "mermaid";
  id: string;
  source: string;
}

/** Native enriched-markdown has no fenced-block override. Only diagrams leave its engine. */
export function splitMermaidFences(markdown: string): Segment[] {
  if (!/mermaid/i.test(markdown)) return [{ kind: "markdown", id: "0", source: markdown }];
  const segments: Segment[] = [];
  let cursor = 0;
  function visit(node: RootContent): void {
    if (node.type === "code" && node.lang?.toLowerCase() === "mermaid" && node.position) {
      const start = node.position.start.offset!;
      const end = node.position.end.offset!;
      if (start > cursor)
        segments.push({
          kind: "markdown",
          id: String(segments.length),
          source: markdown.slice(cursor, start),
        });
      segments.push({ kind: "mermaid", id: String(segments.length), source: node.value });
      cursor = end;
    } else if ("children" in node) node.children.forEach(visit);
  }
  const tree = fromMarkdown(markdown);
  tree.children.forEach(visit);
  if (cursor < markdown.length || segments.length === 0)
    segments.push({
      kind: "markdown",
      id: String(segments.length),
      source: markdown.slice(cursor),
    });
  // Original source slices and fence offsets stay intact.
  if (segments.some((segment) => segment.kind === "mermaid")) {
    const referenceSource = referenceDefinitionSource(tree);
    if (referenceSource)
      for (const segment of segments) {
        if (segment.kind === "markdown") segment.source = `${referenceSource}\n\n${segment.source}`;
      }
  }
  return segments;
}
