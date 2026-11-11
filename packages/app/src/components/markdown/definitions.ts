import type { Definition, Nodes, Root } from "mdast";

/**
 * The document's link reference definitions as Markdown, for fragments that render
 * on their own. Prepend it to each fragment: the first definition of a label wins,
 * so fragment-local duplicates cannot override the document's.
 */
export function referenceDefinitionSource(tree: Root): string {
  const definitions = new Map<string, Definition>();
  function visit(node: Nodes): void {
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node);
    if ("children" in node) node.children.forEach(visit);
  }
  visit(tree);
  return [...definitions.values()]
    .map((node) => {
      const label = node.identifier.replace(/[\\[\]]/g, "\\$&");
      const url = node.url.replace(/[\\<>]/g, "\\$&");
      const title = node.title ? ` "${node.title.replace(/[\\"]/g, "\\$&")}"` : "";
      return `[${label}]: <${url}>${title}`;
    })
    .join("\n");
}
