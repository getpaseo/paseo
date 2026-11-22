import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import type { Nodes } from "mdast";
import { scanMath } from "./math";

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
  // The last closed block may open a display equation whose closing $$ has not
  // streamed in yet. Keep that whole block in the mutable tail so a half
  // equation is never frozen into the head as a literal $$.
  let lastClosed: Nodes | null = null;
  for (const node of tree.children) {
    if (node.position!.start.offset! < boundary) lastClosed = node;
    else break;
  }
  if (lastClosed) {
    const { start, end } = lastClosed.position!;
    const blockSource = completeLines.slice(start.offset!, end.offset!).replace(/\n+$/, "");
    if (scanMath(blockSource).pending.some((opener) => opener.display)) {
      boundary = text.lastIndexOf("\n", start.offset! - 1) + 1;
    }
  }
  return { head: text.slice(0, boundary), tail: text.slice(boundary) };
}
