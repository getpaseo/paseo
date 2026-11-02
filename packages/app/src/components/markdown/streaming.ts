import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import type { Nodes } from "mdast";

// A later definition can resolve even a currently plain-text shortcut reference.
// Keep its entire containing block, and all definitions, in the shared tail.
// HTML normalization likewise needs the complete enclosing source.
function needsDocumentContext(node: Nodes): boolean {
  if (node.type === "html" || node.type === "definition") return true;
  if (node.type === "linkReference" || node.type === "imageReference") return true;
  if (node.type === "text" && node.value.includes("[")) return true;
  return "children" in node && node.children.some(needsDocumentContext);
}

/** The last parsed block and unfinished line are mutable; earlier blocks are closed. */
export function splitStreamingMarkdown(text: string, streaming: boolean) {
  if (!streaming) return { head: text, tail: "" };
  const completeLines = text.slice(0, text.lastIndexOf("\n") + 1);
  const tree = fromMarkdown(completeLines, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
  let boundary = 0;
  for (let index = 0; index < tree.children.length - 1; index++) {
    if (needsDocumentContext(tree.children[index])) break;
    // mdast starts some nodes after their indentation; the next parser needs it too.
    const nextStart = tree.children[index + 1].position!.start.offset!;
    boundary = text.lastIndexOf("\n", nextStart - 1) + 1;
  }
  return { head: text.slice(0, boundary), tail: text.slice(boundary) };
}
