import type { Root } from "mdast";

/**
 * A heading or example label may pin its anchor with a trailing `{#id}`. Translations pin every
 * anchor to the English one, so `/zh-CN/docs/cli#agent-run` lands on the same section as
 * `/docs/cli#agent-run` and links between docs keep working in every language.
 */
const ANCHOR_ID = /\s*\{#([A-Za-z0-9_-]+)\}\s*$/;

export function splitAnchorId(text: string): { text: string; id: string | undefined } {
  const match = ANCHOR_ID.exec(text);
  return match ? { text: text.slice(0, match.index), id: match[1] } : { text, id: undefined };
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, unknown> } & Record<string, unknown>;
}

/** Removes a trailing `{#id}` from the last text in `node` and returns the id. */
export function takeAnchorId(node: MarkdownNode): string | undefined {
  const last = node.children?.at(-1);
  if (!last || last.type !== "text" || last.value === undefined) return undefined;
  const { text, id } = splitAnchorId(last.value);
  if (id === undefined) return undefined;
  last.value = text;
  if (!text) node.children?.pop();
  return id;
}

/** Applies `{#id}` heading anchors; rehype-slug keeps an id that is already set. */
export function remarkHeadingIds() {
  return (tree: Root) => {
    visit(tree as unknown as MarkdownNode, (node) => {
      if (node.type !== "heading") return;
      const id = takeAnchorId(node);
      if (id === undefined) return;
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id } };
    });
  };
}

function visit(node: MarkdownNode, visitor: (node: MarkdownNode) => void): void {
  visitor(node);
  for (const child of node.children ?? []) visit(child, visitor);
}
