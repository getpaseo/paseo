import type { DiffLine, ParsedDiffFile } from "@/hooks/use-checkout-diff-query";

export interface SplitDiffDisplayLine {
  type: DiffLine["type"];
  content: string;
  tokens?: DiffLine["tokens"];
  lineNumber: number | null;
}

export interface UnifiedDiffDisplayLine {
  key: string;
  line: DiffLine;
  lineNumber: number | null;
}

export type SplitDiffRow =
  | {
      kind: "header";
      content: string;
    }
  | {
      kind: "pair";
      left: SplitDiffDisplayLine | null;
      right: SplitDiffDisplayLine | null;
    };

function toDisplayLine(input: {
  line: DiffLine;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  side: "left" | "right";
}): SplitDiffDisplayLine | null {
  const { line, oldLineNumber, newLineNumber, side } = input;
  if (line.type === "header") {
    return null;
  }

  if (line.type === "remove") {
    if (side !== "left") {
      return null;
    }
    return {
      type: "remove",
      content: line.content,
      tokens: line.tokens,
      lineNumber: oldLineNumber,
    };
  }

  if (line.type === "add") {
    if (side !== "right") {
      return null;
    }
    return {
      type: "add",
      content: line.content,
      tokens: line.tokens,
      lineNumber: newLineNumber,
    };
  }

  return {
    type: "context",
    content: line.content,
    tokens: line.tokens,
    lineNumber: side === "left" ? oldLineNumber : newLineNumber,
  };
}

export function buildUnifiedDiffLines(file: ParsedDiffFile): UnifiedDiffDisplayLine[] {
  const lines: UnifiedDiffDisplayLine[] = [];

  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    let oldLineNo = hunk.oldStart;
    let newLineNo = hunk.newStart;

    for (const [lineIndex, line] of hunk.lines.entries()) {
      let lineNumber: number | null = null;

      if (line.type === "remove") {
        lineNumber = oldLineNo;
        oldLineNo += 1;
      } else if (line.type === "add") {
        lineNumber = newLineNo;
        newLineNo += 1;
      } else if (line.type === "context") {
        lineNumber = newLineNo;
        oldLineNo += 1;
        newLineNo += 1;
      }

      lines.push({
        key: `${hunkIndex}-${lineIndex}`,
        line,
        lineNumber,
      });
    }
  }

  return lines;
}

export function buildSplitDiffRows(file: ParsedDiffFile): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];

  for (const hunk of file.hunks) {
    let oldLineNo = hunk.oldStart;
    let newLineNo = hunk.newStart;
    rows.push({
      kind: "header",
      content: hunk.lines[0]?.type === "header" ? hunk.lines[0].content : "@@",
    });

    let pendingRemovals: Array<{ line: DiffLine; oldLineNumber: number }> = [];
    let pendingAdditions: Array<{ line: DiffLine; newLineNumber: number }> = [];

    const flushPendingRows = () => {
      const pairCount = Math.max(pendingRemovals.length, pendingAdditions.length);
      for (let index = 0; index < pairCount; index += 1) {
        const removal = pendingRemovals[index] ?? null;
        const addition = pendingAdditions[index] ?? null;
        rows.push({
          kind: "pair",
          left: removal
            ? toDisplayLine({
                line: removal.line,
                oldLineNumber: removal.oldLineNumber,
                newLineNumber: null,
                side: "left",
              })
            : null,
          right: addition
            ? toDisplayLine({
                line: addition.line,
                oldLineNumber: null,
                newLineNumber: addition.newLineNumber,
                side: "right",
              })
            : null,
        });
      }
      pendingRemovals = [];
      pendingAdditions = [];
    };

    for (const line of hunk.lines.slice(1)) {
      if (line.type === "remove") {
        pendingRemovals.push({ line, oldLineNumber: oldLineNo });
        oldLineNo += 1;
        continue;
      }

      if (line.type === "add") {
        pendingAdditions.push({ line, newLineNumber: newLineNo });
        newLineNo += 1;
        continue;
      }

      flushPendingRows();

      if (line.type === "context") {
        rows.push({
          kind: "pair",
          left: toDisplayLine({
            line,
            oldLineNumber: oldLineNo,
            newLineNumber: newLineNo,
            side: "left",
          }),
          right: toDisplayLine({
            line,
            oldLineNumber: oldLineNo,
            newLineNumber: newLineNo,
            side: "right",
          }),
        });
        oldLineNo += 1;
        newLineNo += 1;
      }
    }

    flushPendingRows();
  }

  return rows;
}
