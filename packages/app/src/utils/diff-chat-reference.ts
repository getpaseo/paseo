import type { DiffHunk } from "@/hooks/use-checkout-diff-query";

export interface DiffReferenceRange {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface DiffHunkLinePosition {
  type: DiffHunk["lines"][number]["type"];
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

function isChangeLineType(type: DiffHunk["lines"][number]["type"]): boolean {
  return type === "add" || type === "remove";
}

export function buildHunkLinePositions(hunk: DiffHunk): DiffHunkLinePosition[] {
  let oldLineNo = hunk.oldStart;
  let newLineNo = hunk.newStart;

  return hunk.lines.map((line) => {
    const oldLineNumber = line.type === "remove" || line.type === "context" ? oldLineNo : null;
    const newLineNumber = line.type === "add" || line.type === "context" ? newLineNo : null;

    if (line.type === "remove") {
      oldLineNo += 1;
    } else if (line.type === "add") {
      newLineNo += 1;
    } else if (line.type === "context") {
      oldLineNo += 1;
      newLineNo += 1;
    }

    return {
      type: line.type,
      oldLineNumber,
      newLineNumber,
    };
  });
}

export function buildContextReferenceRange(input: {
  hunk: DiffHunk;
  positions: DiffHunkLinePosition[];
  lineIndex: number;
}): DiffReferenceRange | null {
  const position = input.positions[input.lineIndex];
  if (!position || position.type !== "context") {
    return null;
  }

  return {
    oldStart: position.oldLineNumber ?? position.newLineNumber ?? input.hunk.oldStart,
    oldCount: position.oldLineNumber != null ? 1 : 0,
    newStart: position.newLineNumber ?? position.oldLineNumber ?? input.hunk.newStart,
    newCount: position.newLineNumber != null ? 1 : 0,
  };
}

export function findContiguousChangeBlock(input: {
  hunk: DiffHunk;
  lineIndex: number;
}): { startIndex: number; endIndex: number } | null {
  const line = input.hunk.lines[input.lineIndex];
  if (!line || !isChangeLineType(line.type)) {
    return null;
  }

  let startIndex = input.lineIndex;
  while (startIndex > 1 && isChangeLineType(input.hunk.lines[startIndex - 1]?.type)) {
    startIndex -= 1;
  }

  let endIndex = input.lineIndex;
  while (
    endIndex + 1 < input.hunk.lines.length &&
    isChangeLineType(input.hunk.lines[endIndex + 1]?.type)
  ) {
    endIndex += 1;
  }

  return { startIndex, endIndex };
}

export function buildChangeBlockReferenceRange(input: {
  hunk: DiffHunk;
  positions: DiffHunkLinePosition[];
  startIndex: number;
  endIndex: number;
}): DiffReferenceRange | null {
  let oldStart: number | null = null;
  let oldCount = 0;
  let newStart: number | null = null;
  let newCount = 0;

  for (let index = input.startIndex; index <= input.endIndex; index += 1) {
    const position = input.positions[index];
    if (!position) {
      continue;
    }

    if (position.type === "remove" && position.oldLineNumber != null) {
      oldStart ??= position.oldLineNumber;
      oldCount += 1;
    } else if (position.type === "add" && position.newLineNumber != null) {
      newStart ??= position.newLineNumber;
      newCount += 1;
    }
  }

  if (newCount === 0 && oldStart != null && oldCount > 0) {
    const previousPosition = input.positions[input.startIndex - 1];
    const nextPosition = input.positions[input.endIndex + 1];
    const surroundingNewStart =
      previousPosition?.type === "context"
        ? previousPosition.newLineNumber
        : nextPosition?.type === "context"
          ? nextPosition.newLineNumber
          : null;
    const surroundingNewEnd =
      nextPosition?.type === "context"
        ? nextPosition.newLineNumber
        : previousPosition?.type === "context"
          ? previousPosition.newLineNumber
          : null;

    if (surroundingNewStart != null && surroundingNewEnd != null) {
      return {
        oldStart,
        oldCount,
        newStart: surroundingNewStart,
        newCount: surroundingNewEnd - surroundingNewStart + 1,
      };
    }
  }

  if (oldStart == null && newStart == null) {
    return null;
  }

  const fallbackStart = newStart ?? oldStart ?? input.hunk.newStart ?? input.hunk.oldStart;

  return {
    oldStart: oldStart ?? fallbackStart,
    oldCount,
    newStart: newStart ?? fallbackStart,
    newCount,
  };
}
