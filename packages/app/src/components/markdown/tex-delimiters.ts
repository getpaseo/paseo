import type { Nodes, Root } from "mdast";

// md4c opens a `$` run only after whitespace, punctuation (Unicode P or S) or a line start,
// and closes it only before one of them. A neighbouring `$` or `\` would join the run.
const FLANKING = /[\s\p{P}\p{S}]/u;
const TEX_DELIMITER = /(\\+)([()[\]])/g;
const DOLLAR_RUN = /(\\*)(\$+)/g;

export interface SourceEdit {
  start: number;
  end: number;
  text: string;
}

type Range = [number, number];

/** Source offsets md4c reads as math, delimiters included, sorted and disjoint. */
export type MathRanges = readonly (readonly [number, number])[];

interface Delimiter {
  index: number;
  char: string;
  block: Nodes;
}

interface DollarRun {
  index: number;
  length: number;
  opens: boolean;
  closes: boolean;
  /** A rewritten TeX pair sits between this run and the previous one. */
  afterTex: boolean;
}

function flanks(char: string | undefined): boolean {
  return char === undefined || FLANKING.test(char);
}

function hasUnescapedDollar(text: string): boolean {
  return /(?:^|[^\\])(?:\\\\)*\$/.test(text);
}

/** Text node ranges grouped by their paragraph, heading or table cell, in source order. */
function textRunsByBlock(tree: Root): Map<Nodes, Range[]> {
  const blocks = new Map<Nodes, Range[]>();
  function visit(node: Nodes, block: Nodes) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "text" && start !== undefined && end !== undefined) {
      const runs = blocks.get(block);
      if (runs) runs.push([start, end]);
      else blocks.set(block, [[start, end]]);
      return;
    }
    if (!("children" in node)) return;
    for (const child of node.children) {
      const leaf =
        child.type === "paragraph" || child.type === "heading" || child.type === "tableCell";
      visit(child, leaf ? child : block);
    }
  }
  visit(tree, tree);
  return blocks;
}

function texDelimiters(source: string, blocks: Map<Nodes, Range[]>): Delimiter[] {
  const delimiters: Delimiter[] = [];
  for (const [block, runs] of blocks) {
    for (const [start, end] of runs) {
      for (const match of source.slice(start, end).matchAll(TEX_DELIMITER)) {
        // An even run of backslashes is escaped backslashes before a plain bracket.
        if (match[1].length % 2 === 0) continue;
        const index = start + match.index + match[1].length - 1;
        delimiters.push({ index, char: match[2], block });
      }
    }
  }
  return delimiters.sort((a, b) => a.index - b.index);
}

/** Pair `\(` `\)` and `\[` `\]` within one block and rewrite them to md4c's dollars. */
function rewriteTexPairs(source: string, delimiters: Delimiter[], edits: SourceEdit[]): Range[] {
  const pairs: Range[] = [];
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
    if (content.trim() && !hasUnescapedDollar(content)) {
      const mark = open.char === "(" ? "$" : "$$";
      const prev = source[open.index - 1];
      const next = source[delimiter.index + 2];
      const before = flanks(prev) && prev !== "$" ? "" : " ";
      const after = flanks(next) && next !== "$" && next !== "\\" ? "" : " ";
      edits.push({ start: open.index, end: open.index + 2, text: `${before}${mark}` });
      edits.push({ start: delimiter.index, end: delimiter.index + 2, text: `${mark}${after}` });
      pairs.push([open.index, delimiter.index + 2]);
    }
    open = undefined;
  }
  return pairs;
}

function dollarRuns(source: string, runs: Range[], tex: Range[]): DollarRun[] {
  const found: DollarRun[] = [];
  let last = -1;
  for (const [start, end] of runs) {
    for (const match of source.slice(start, end).matchAll(DOLLAR_RUN)) {
      const index = start + match.index + match[1].length;
      const length = match[2].length;
      const escaped = match[1].length % 2 === 1;
      if (escaped || length > 2 || tex.some(([s, e]) => index >= s && index < e)) continue;
      const afterTex = tex.some(([s, e]) => s > last && e <= index);
      last = index;
      const opens = flanks(source[index - 1]);
      const closes = flanks(source[index + length]);
      found.push({ index, length, opens, closes, afterTex });
    }
  }
  return found;
}

/**
 * Authored `$` / `$$` spans, paired the way md4c pairs dollar marks: a closer ends the innermost
 * opener of the same length, and any resolved span, a rewritten TeX pair included, drops every
 * pending opener.
 */
function dollarSpans(runs: DollarRun[]): Range[] {
  const spans: Range[] = [];
  const openers: DollarRun[] = [];
  for (const run of runs) {
    if (run.afterTex) openers.length = 0;
    const top = openers.at(-1);
    if (run.closes && top?.length === run.length) {
      spans.push([top.index, run.index + run.length]);
      openers.length = 0;
    } else if (run.opens) {
      openers.push(run);
    }
  }
  return spans;
}

/**
 * Models write TeX's own delimiters, `\(...\)` inline and `\[...\]` display. CommonMark reads
 * those backslashes as escapes, so the formula reaches the page as bare brackets around source.
 * Returns edits that rewrite them to the `$` / `$$` delimiters md4c parses, and the ranges md4c
 * will read as math (rewritten pairs and authored `$` spans) so prose rewrites can skip them.
 * Only delimiters in text count, so code spans, fences and HTML keep their spelling; a pair must
 * close inside the same paragraph, heading or table cell.
 */
export function findMath(source: string, tree: Root): { edits: SourceEdit[]; ranges: MathRanges } {
  const edits: SourceEdit[] = [];
  const hasTex = source.includes("\\(") || source.includes("\\[");
  if (!hasTex && !source.includes("$")) return { edits, ranges: [] };
  const blocks = textRunsByBlock(tree);
  const tex = hasTex ? rewriteTexPairs(source, texDelimiters(source, blocks), edits) : [];
  const ranges = [...tex];
  for (const runs of blocks.values()) ranges.push(...dollarSpans(dollarRuns(source, runs, tex)));
  return { edits, ranges: ranges.sort((a, b) => a[0] - b[0]) };
}

export function inMathRange(ranges: MathRanges, start: number, end = start + 1): boolean {
  return ranges.some(([s, e]) => start < e && end > s);
}
