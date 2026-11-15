import {
  classifyMathFlankChar,
  findProtectedMathRangeAt,
  hasUnescapedDollar,
  isMathRangeOverlapping,
  matchMathAtDollar,
  type MathTextRange,
  type ProtectedMathRange,
} from "@getpaseo/protocol/markdown-math";

export type TextRange = MathTextRange;
export type ProtectedTextRange = ProtectedMathRange;

export interface SourceEdit {
  start: number;
  end: number;
  text: string;
}

export { hasUnescapedDollar };
export const isRangeOverlapping = isMathRangeOverlapping;

const CJK_HAIR_SPACE = "\u200a";

function recordValidMathSpan(options: {
  source: string;
  blockStart: number;
  blockEnd: number;
  openStart: number;
  closeEnd: number;
  edits: SourceEdit[];
  mathRanges: TextRange[];
}) {
  const { source, blockStart, blockEnd, openStart, closeEnd, edits, mathRanges } = options;
  mathRanges.push({ start: openStart, end: closeEnd });
  const beforeFlank = classifyMathFlankChar(
    openStart > blockStart ? source[openStart - 1] : undefined,
  );
  if (beforeFlank === "cjk") {
    edits.push({ start: openStart, end: openStart, text: CJK_HAIR_SPACE });
  }
  const afterFlank = classifyMathFlankChar(closeEnd < blockEnd ? source[closeEnd] : undefined);
  if (afterFlank === "cjk") {
    edits.push({ start: closeEnd, end: closeEnd, text: CJK_HAIR_SPACE });
  }
}

/**
 * Distinguish valid `$...$` / `$$...$$` LaTeX math spans from prose currency and
 * shell `$` tokens, escaping non-math `$` as `\$` so MD4C leaves prose intact.
 */
export function prepareMarkdownMath(options: {
  source: string;
  blocks: readonly TextRange[];
  protectedRanges: readonly ProtectedTextRange[];
}): { edits: SourceEdit[]; mathRanges: TextRange[] } {
  const { source, blocks, protectedRanges } = options;
  const edits: SourceEdit[] = [];
  const mathRanges: TextRange[] = [];
  const sortedProtected = [...protectedRanges].sort((a, b) => a.start - b.start);

  for (const block of blocks) {
    let pos = block.start;
    while (pos < block.end) {
      const guarded = findProtectedMathRangeAt(sortedProtected, pos);
      if (guarded) {
        pos = guarded.end;
        continue;
      }
      if (source[pos] === "\\" && pos + 1 < block.end) {
        pos += 2;
        continue;
      }
      if (source[pos] !== "$") {
        pos++;
        continue;
      }
      const token = matchMathAtDollar({
        source,
        pos,
        blockStart: block.start,
        blockEnd: block.end,
        protectedRanges: sortedProtected,
      });
      if (token.kind !== "literal") {
        recordValidMathSpan({
          source,
          blockStart: block.start,
          blockEnd: block.end,
          openStart: token.openStart,
          closeEnd: token.closeEnd,
          edits,
          mathRanges,
        });
        pos = token.closeEnd;
        continue;
      }
      edits.push({ start: token.start, end: token.end, text: "\\$".repeat(token.count) });
      pos = token.end;
    }
  }

  return { edits, mathRanges };
}
