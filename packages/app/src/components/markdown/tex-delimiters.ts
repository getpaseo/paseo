import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import type { Nodes } from "mdast";

// md4c opens a `$` run only after whitespace, punctuation (Unicode P or S) or a line start,
// and closes it only before one of them. A neighbouring `$` or `\` would join the run.
const FLANKING = /[\s\p{P}\p{S}]/u;
const DELIMITER = /(\\+)([()[\]])/g;

interface Delimiter {
  index: number;
  char: string;
  block: Nodes;
}

function flanks(char: string | undefined): boolean {
  return char === undefined || (char !== "$" && char !== "\\" && FLANKING.test(char));
}

/**
 * Models write TeX's own delimiters, `\(...\)` inline and `\[...\]` display. CommonMark reads
 * those backslashes as escapes, so the formula reaches the page as bare brackets around source.
 * Rewrite them to the `$` / `$$` delimiters md4c parses. Only delimiters in text count, so code
 * spans, fences and HTML keep their spelling; a pair must close inside the same paragraph,
 * heading or table cell.
 */
export function normalizeTexDelimiters(source: string): string {
  if (!source.includes("\\(") && !source.includes("\\[")) return source;
  const tree = fromMarkdown(source, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
  const delimiters: Delimiter[] = [];
  function visit(node: Nodes, block: Nodes) {
    if (node.type === "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      for (const match of source.slice(start, end).matchAll(DELIMITER)) {
        // An even run of backslashes is escaped backslashes before a plain bracket.
        if (match[1].length % 2 === 0) continue;
        delimiters.push({
          index: start + match.index + match[1].length - 1,
          char: match[2],
          block,
        });
      }
      return;
    }
    if (!("children" in node)) return;
    for (const child of node.children) {
      const leafBlock =
        child.type === "paragraph" || child.type === "heading" || child.type === "tableCell";
      visit(child, leafBlock ? child : block);
    }
  }
  visit(tree, tree);

  const edits: { start: number; end: number; text: string }[] = [];
  let open: Delimiter | undefined;
  for (const delimiter of delimiters) {
    if (open && open.block !== delimiter.block) open = undefined;
    if (!open) {
      if (delimiter.char === "(" || delimiter.char === "[") open = delimiter;
      continue;
    }
    if (delimiter.char !== (open.char === "(" ? ")" : "]")) continue;
    const content = source.slice(open.index + 2, delimiter.index);
    // An unescaped `$` inside would end the md4c span early.
    if (content.trim() && !/(?:^|[^\\])(?:\\\\)*\$/.test(content)) {
      const mark = open.char === "(" ? "$" : "$$";
      const before = flanks(source[open.index - 1]) ? "" : " ";
      const after = flanks(source[delimiter.index + 2]) ? "" : " ";
      edits.push({ start: open.index, end: open.index + 2, text: `${before}${mark}` });
      edits.push({ start: delimiter.index, end: delimiter.index + 2, text: `${mark}${after}` });
    }
    open = undefined;
  }
  let result = source;
  for (const edit of edits.toReversed()) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}
