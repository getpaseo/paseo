import type { Parser, Tree } from "@lezer/common";
import { highlightTree } from "@lezer/highlight";
import type { HighlightStyle, HighlightToken } from "./types.js";
import { getParserForFile } from "./parsers.js";

import { staticSyntaxHighlighter } from "./syntax-roles.js";

/** Parser steps per unit of work: one step shifts or reduces a token. */
const PARSE_STEPS_PER_UNIT = 200;
/** Lines highlighted per unit of work. */
const LINES_PER_UNIT = 200;

export interface HighlightStepsOptions {
  /**
   * Highlight this many lines first and yield every line, those highlighted and the rest plain,
   * before highlighting the whole file.
   */
  firstLines?: number;
}

/** One unit of work done (`undefined`), or every line with the first ones highlighted. */
export type HighlightStep = HighlightToken[][] | undefined;

export function highlightCode(code: string, filename: string): HighlightToken[][] {
  const steps = highlightCodeInSteps(code, filename);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * Highlights `code` one bounded unit of work per `next()`, returning the highlighted lines when
 * done. Drive it under a time budget so a large file does not block the thread.
 *
 * The parser reads the file from its start, so a large file takes a while before any line is
 * highlighted. With `firstLines`, it first parses only as far as those lines and yields them.
 */
export function* highlightCodeInSteps(
  code: string,
  filename: string,
  options: HighlightStepsOptions = {},
): Generator<HighlightStep, HighlightToken[][], void> {
  const lines = code.split("\n");
  const parser = getParserForFile(filename);
  if (!parser) return lines.map(plainLine);

  const firstLines = options.firstLines ?? 0;
  // Highlighting the first lines first costs their parse twice; it pays only for a small share.
  if (firstLines > 0 && firstLines < lines.length / 2) {
    const firstTree = yield* parseInSteps(parser, code, lineOffset(lines, firstLines));
    const first = yield* highlightLinesInSteps(code, lines, firstTree, firstLines);
    yield [...first, ...lines.slice(firstLines).map(plainLine)];
  }
  const tree = yield* parseInSteps(parser, code);
  return yield* highlightLinesInSteps(code, lines, tree, lines.length);
}

function* parseInSteps(
  parser: Parser,
  code: string,
  stopAt?: number,
): Generator<undefined, Tree, void> {
  const parse = parser.startParse(code);
  if (stopAt !== undefined) parse.stopAt(stopAt);
  for (let step = 1; ; step++) {
    const tree = parse.advance();
    if (tree) return tree;
    if (step % PARSE_STEPS_PER_UNIT === 0) yield;
  }
}

/** Highlights the first `lineCount` lines of `code` from its parse `tree`. */
function* highlightLinesInSteps(
  code: string,
  lines: string[],
  tree: Tree,
  lineCount: number,
): Generator<undefined, HighlightToken[][], void> {
  const result: HighlightToken[][] = lines.slice(0, lineCount).map(() => []);
  const tokens = new LineTokenWriter(code, lines, result);
  let chunkFrom = 0;
  for (let first = 0; first < lineCount; first += LINES_PER_UNIT) {
    const last = Math.min(first + LINES_PER_UNIT, lineCount);
    let chunkTo = chunkFrom;
    for (let line = first; line < last; line++) chunkTo += lines[line].length + 1;
    chunkTo = Math.min(chunkTo, code.length);

    let cursor = chunkFrom;
    highlightTree(
      tree,
      staticSyntaxHighlighter,
      (from, to, classes) => {
        tokens.write(cursor, from, null);
        tokens.write(from, to, classes as HighlightStyle);
        cursor = to;
      },
      chunkFrom,
      chunkTo,
    );
    tokens.write(cursor, chunkTo, null);
    chunkFrom = chunkTo;
    yield;
  }

  for (const line of result) {
    if (line.length === 0) line.push({ text: "", style: null });
  }
  return result;
}

/** The offset where line `lineIndex` starts: past each earlier line and its newline. */
function lineOffset(lines: string[], lineIndex: number): number {
  let offset = 0;
  for (let line = 0; line < lineIndex; line++) offset += lines[line].length + 1;
  return offset;
}

function plainLine(line: string): HighlightToken[] {
  return [{ text: line, style: null }];
}

/** Splits styled ranges of the code into per-line tokens, written in order. */
class LineTokenWriter {
  private line = 0;
  private lineFrom = 0;

  constructor(
    private readonly code: string,
    private readonly lines: string[],
    private readonly result: HighlightToken[][],
  ) {}

  write(from: number, to: number, style: HighlightStyle | null): void {
    while (from < to) {
      let lineEnd = this.lineFrom + this.lines[this.line].length;
      while (from > lineEnd) {
        this.line++;
        this.lineFrom = lineEnd + 1;
        lineEnd = this.lineFrom + this.lines[this.line].length;
      }
      const end = Math.min(to, lineEnd);
      if (end > from) this.append(this.code.slice(from, end), style);
      from = end === lineEnd ? lineEnd + 1 : end;
    }
  }

  private append(text: string, style: HighlightStyle | null): void {
    const tokens = this.result[this.line];
    const last = tokens[tokens.length - 1];
    if (last && last.style === style) last.text += text;
    else tokens.push({ text, style });
  }
}

export function highlightLine(line: string, filename: string): HighlightToken[] {
  const result = highlightCode(line, filename);
  return result[0] ?? [{ text: line, style: null }];
}
