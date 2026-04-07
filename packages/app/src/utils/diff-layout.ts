import type { DiffLine, ParsedDiffFile } from "@/hooks/use-checkout-diff-query";
import { buildDiffRangeChatReference } from "./chat-reference-token";
import {
  buildChangeBlockReferenceRange,
  buildContextReferenceRange,
  buildHunkLinePositions,
  type DiffHunkLinePosition,
} from "./diff-chat-reference";

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
  position: DiffHunkLinePosition;
  side: "left" | "right";
}): SplitDiffDisplayLine | null {
  const { line, position, side } = input;
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
      lineNumber: position.oldLineNumber,
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
      lineNumber: position.newLineNumber,
    };
  }

  return {
    type: "context",
    content: line.content,
    tokens: line.tokens,
    lineNumber: side === "left" ? position.oldLineNumber : position.newLineNumber,
  };
}

export function buildSplitDiffRows(file: ParsedDiffFile): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];

  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    const positions = buildHunkLinePositions(hunk);
    let hasChangedLine = false;
    rows.push({
      kind: "header",
      content: hunk.lines[0]?.type === "header" ? hunk.lines[0].content : "@@",
      hunkIndex,
    });

    let pendingRemovalIndices: number[] = [];
    let pendingAdditionIndices: number[] = [];

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

    const flushPendingRows = () => {
      const pairCount = Math.max(pendingRemovalIndices.length, pendingAdditionIndices.length);
      if (pairCount === 0) {
        return;
      }

      const range = buildChangeBlockReferenceRange({
        hunk,
        positions,
        startIndex:
          Math.min(
            pendingRemovalIndices[0] ?? Number.POSITIVE_INFINITY,
            pendingAdditionIndices[0] ?? Number.POSITIVE_INFINITY,
          ) || 0,
        endIndex:
          Math.max(
            pendingRemovalIndices[pendingRemovalIndices.length - 1] ?? Number.NEGATIVE_INFINITY,
            pendingAdditionIndices[pendingAdditionIndices.length - 1] ?? Number.NEGATIVE_INFINITY,
          ) || 0,
      });
      const chatReference = buildDiffRangeChatReference({
        path: file.path,
        ...(range ?? {
          oldStart: hunk.oldStart,
          oldCount: hunk.oldCount,
          newStart: hunk.newStart,
          newCount: hunk.newCount,
        }),
      });

      for (let index = 0; index < pairCount; index += 1) {
        const removalIndex = pendingRemovalIndices[index];
        const additionIndex = pendingAdditionIndices[index];
        const removalLine = removalIndex != null ? hunk.lines[removalIndex] : null;
        const additionLine = additionIndex != null ? hunk.lines[additionIndex] : null;
        pushPairRow({
          chatReference,
          hasChanges: true,
          left: removalLine && removalIndex != null
            ? toDisplayLine({
                line: removalLine,
                position: positions[removalIndex],
                side: "left",
              })
            : null,
          right: additionLine && additionIndex != null
            ? toDisplayLine({
                line: additionLine,
                position: positions[additionIndex],
                side: "right",
              })
            : null,
        });
      }
      pendingRemovalIndices = [];
      pendingAdditionIndices = [];
    };

    for (const [lineIndex, line] of hunk.lines.entries()) {
      if (lineIndex === 0) {
        continue;
      }

      if (line.type === "remove") {
        pendingRemovalIndices.push(lineIndex);
        continue;
      }

      if (line.type === "add") {
        pendingAdditionIndices.push(lineIndex);
        continue;
      }

      flushPendingRows();

      if (line.type === "context") {
        const range = buildContextReferenceRange({
          hunk,
          positions,
          lineIndex,
        });
        const position = positions[lineIndex];
        if (!range || !position) {
          continue;
        }

        pushPairRow({
          chatReference: buildDiffRangeChatReference({
            path: file.path,
            ...range,
          }),
          hasChanges: false,
          left: toDisplayLine({
            line,
            position,
            side: "left",
          }),
          right: toDisplayLine({
            line,
            position,
            side: "right",
          }),
        });
      }
    }

    flushPendingRows();
  }

  return rows;
}
