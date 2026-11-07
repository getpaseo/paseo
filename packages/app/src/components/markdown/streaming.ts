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

/**
 * The last parsed block and unfinished line are mutable; earlier blocks are closed.
 *
 * `settled` is a head length this function returned for a prefix of `text`. Closed blocks need
 * no document context, so the source after them parses the same on its own.
 */
export function splitStreamingMarkdown(text: string, streaming: boolean, settled = 0) {
  if (!streaming) return { head: text, tail: "" };
  const open = text.slice(settled);
  const completeLines = open.slice(0, open.lastIndexOf("\n") + 1);
  const tree = fromMarkdown(completeLines, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
  let boundary = 0;
  for (let index = 0; index < tree.children.length - 1; index++) {
    if (needsDocumentContext(tree.children[index])) break;
    // mdast starts some nodes after their indentation; the next parser needs it too.
    const nextStart = tree.children[index + 1].position!.start.offset!;
    boundary = open.lastIndexOf("\n", nextStart - 1) + 1;
  }
  boundary += settled;
  return { head: text.slice(0, boundary), tail: text.slice(boundary) };
}

/**
 * Finds the streaming boundary for a growing message. Reparsing the whole message on every
 * completed line made a long reply cost more per line the longer it got; this parses only the
 * source after the head it already settled.
 */
export function createStreamingMarkdownSplitter() {
  let settledHead = "";
  return (completeLines: string): number => {
    const settled = completeLines.startsWith(settledHead) ? settledHead.length : 0;
    const boundary = splitStreamingMarkdown(completeLines, true, settled).head.length;
    settledHead = completeLines.slice(0, boundary);
    return boundary;
  };
}
