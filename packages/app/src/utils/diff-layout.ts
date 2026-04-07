import type { DiffLine, ParsedDiffFile } from "@/hooks/use-checkout-diff-query";
import { buildDiffRangeChatReference } from "./chat-reference-token";

export interface SplitDiffDisplayLine {
  type: DiffLine["type"];
  content: string;
  tokens?: DiffLine["tokens"];
  lineNumber: number | null;
}

export type SplitDiffRow =
  | {
      kind: "header";
      content: string;
      hunkIndex: number;
    }
  | {
      kind: "pair";
      hunkIndex: number;
      isFirstChangedLineInHunk: boolean;
      chatReference: string;
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

export function buildSplitDiffRows(file: ParsedDiffFile): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];

  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    let oldLineNo = hunk.oldStart;
    let newLineNo = hunk.newStart;
    let hasChangedLine = false;
    let previousContextNewLineNumber: number | null = null;
    rows.push({
      kind: "header",
      content: hunk.lines[0]?.type === "header" ? hunk.lines[0].content : "@@",
      hunkIndex,
    });

    let pendingRemovals: Array<{ line: DiffLine; oldLineNumber: number }> = [];
    let pendingAdditions: Array<{ line: DiffLine; newLineNumber: number }> = [];

    const pushPairRow = (input: {
      chatReference: string;
      hasChanges: boolean;
      left: SplitDiffDisplayLine | null;
      right: SplitDiffDisplayLine | null;
    }) => {
      rows.push({
        kind: "pair",
        hunkIndex,
        isFirstChangedLineInHunk: input.hasChanges && !hasChangedLine,
        chatReference: input.chatReference,
        left: input.left,
        right: input.right,
      });
      if (input.hasChanges) {
        hasChangedLine = true;
      }
    };

    const flushPendingRows = (nextContextNewLineNumber?: number | null) => {
      const pairCount = Math.max(pendingRemovals.length, pendingAdditions.length);
      const fallbackStart =
        pendingAdditions[0]?.newLineNumber ?? pendingRemovals[0]?.oldLineNumber ?? hunk.newStart;
      const oldStart = pendingRemovals[0]?.oldLineNumber ?? fallbackStart;
      const oldCount = pendingRemovals.length;
      const newStart = pendingAdditions[0]?.newLineNumber ?? fallbackStart;
      const newCount = pendingAdditions.length;
      const surroundingNewStart =
        previousContextNewLineNumber ?? nextContextNewLineNumber ?? null;
      const surroundingNewEnd =
        nextContextNewLineNumber ?? previousContextNewLineNumber ?? null;
      const chatReference =
        newCount === 0 && oldCount > 0 && surroundingNewStart != null && surroundingNewEnd != null
          ? buildDiffRangeChatReference({
              path: file.path,
              oldStart,
              oldCount,
              newStart: surroundingNewStart,
              newCount: surroundingNewEnd - surroundingNewStart + 1,
            })
          : buildDiffRangeChatReference({
              path: file.path,
              oldStart,
              oldCount,
              newStart,
              newCount,
            });
      for (let index = 0; index < pairCount; index += 1) {
        const removal = pendingRemovals[index] ?? null;
        const addition = pendingAdditions[index] ?? null;
        pushPairRow({
          chatReference,
          hasChanges: true,
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

      flushPendingRows(newLineNo);

      if (line.type === "context") {
        pushPairRow({
          chatReference: buildDiffRangeChatReference({
            path: file.path,
            oldStart: oldLineNo,
            oldCount: 1,
            newStart: newLineNo,
            newCount: 1,
          }),
          hasChanges: false,
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
        previousContextNewLineNumber = newLineNo - 1;
      }
    }

    flushPendingRows();
  }

  return rows;
}
