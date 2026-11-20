import { fromMarkdown } from "mdast-util-from-markdown";
import type { Definition, RootContent } from "mdast";

interface Segment {
  kind: "markdown" | "mermaid";
  id: string;
  source: string;
}

/** Native enriched-markdown has no fenced-block override. Only diagrams leave its engine. */
export function splitMermaidFences(markdown: string): Segment[] {
  if (!/mermaid/i.test(markdown)) return [{ kind: "markdown", id: "0", source: markdown }];
  const segments: Segment[] = [];
  const definitions = new Map<string, Definition>();
  let cursor = 0;
  function visit(node: RootContent): void {
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node);
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
  // Prepend the document's first definitions after splitting, so fragment-local
  // duplicates cannot override them. Original source slices and fence offsets stay intact.
  if (segments.some((segment) => segment.kind === "mermaid")) {
    const referenceSource = [...definitions.values()]
      .map((node) => {
        const label = node.identifier.replace(/[\\[\]]/g, "\\$&");
        const url = node.url.replace(/[\\<>]/g, "\\$&");
        const title = node.title ? ` "${node.title.replace(/[\\"]/g, "\\$&")}"` : "";
        return `[${label}]: <${url}>${title}`;
      })
      .join("\n");
    if (referenceSource)
      for (const segment of segments) {
        if (segment.kind === "markdown") segment.source = `${referenceSource}\n\n${segment.source}`;
      }
  }
  return segments;
}
