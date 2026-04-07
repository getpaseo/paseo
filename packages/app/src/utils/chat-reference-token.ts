import type { DiffHunk } from "@/hooks/use-checkout-diff-query";

function formatLineRange(input: { path: string; start: number; count: number }): string {
  const count = Math.max(1, input.count);
  if (count <= 1) {
    return `${input.path}:${input.start}`;
  }
  const end = input.start + count - 1;
  return `${input.path}:${input.start}-${end}`;
}

export function buildFileChatReference(path: string): string {
  return path;
}

export function buildDiffRangeChatReference(input: {
  path: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}): string {
  if (input.newCount > 0) {
    return formatLineRange({
      path: input.path,
      start: input.newStart,
      count: input.newCount,
    });
  }

  return formatLineRange({
    path: input.path,
    start: input.oldStart,
    count: input.oldCount,
  });
}

export function buildHunkChatReference(input: { path: string; hunk: DiffHunk }): string {
  const { hunk, path } = input;
  return buildDiffRangeChatReference({
    path,
    oldStart: hunk.oldStart,
    oldCount: hunk.oldCount,
    newStart: hunk.newStart,
    newCount: hunk.newCount,
  });
}

function isChangeLineType(type: DiffHunk["lines"][number]["type"]): boolean {
  return type === "add" || type === "remove";
}

export function buildHunkLineChatReference(input: {
  path: string;
  hunk: DiffHunk;
  lineIndex: number;
}): string {
  const { hunk, lineIndex, path } = input;
  const line = hunk.lines[lineIndex];
  if (!line || line.type === "header") {
    return buildHunkChatReference({ path, hunk });
  }

  let oldLineNo = hunk.oldStart;
  let newLineNo = hunk.newStart;
  const positions = hunk.lines.map((currentLine) => {
    const oldLineNumber =
      currentLine.type === "remove" || currentLine.type === "context" ? oldLineNo : null;
    const newLineNumber =
      currentLine.type === "add" || currentLine.type === "context" ? newLineNo : null;

    if (currentLine.type === "remove") {
      oldLineNo += 1;
    } else if (currentLine.type === "add") {
      newLineNo += 1;
    } else if (currentLine.type === "context") {
      oldLineNo += 1;
      newLineNo += 1;
    }

    return {
      type: currentLine.type,
      oldLineNumber,
      newLineNumber,
    };
  });

  const currentPosition = positions[lineIndex];
  if (!currentPosition) {
    return buildHunkChatReference({ path, hunk });
  }

  if (currentPosition.type === "context") {
    return buildDiffRangeChatReference({
      path,
      oldStart: currentPosition.oldLineNumber ?? currentPosition.newLineNumber ?? hunk.oldStart,
      oldCount: currentPosition.oldLineNumber != null ? 1 : 0,
      newStart: currentPosition.newLineNumber ?? currentPosition.oldLineNumber ?? hunk.newStart,
      newCount: currentPosition.newLineNumber != null ? 1 : 0,
    });
  }

  let startIndex = lineIndex;
  while (startIndex > 1 && isChangeLineType(hunk.lines[startIndex - 1]?.type)) {
    startIndex -= 1;
  }

  let endIndex = lineIndex;
  while (endIndex + 1 < hunk.lines.length && isChangeLineType(hunk.lines[endIndex + 1]?.type)) {
    endIndex += 1;
  }

  let oldStart: number | null = null;
  let oldCount = 0;
  let newStart: number | null = null;
  let newCount = 0;

  for (let index = startIndex; index <= endIndex; index += 1) {
    const position = positions[index];
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
    const previousPosition = positions[startIndex - 1];
    const nextPosition = positions[endIndex + 1];
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
      return buildDiffRangeChatReference({
        path,
        oldStart,
        oldCount,
        newStart: surroundingNewStart,
        newCount: surroundingNewEnd - surroundingNewStart + 1,
      });
    }
  }

  const fallbackStart = newStart ?? oldStart ?? hunk.newStart ?? hunk.oldStart;

  return buildDiffRangeChatReference({
    path,
    oldStart: oldStart ?? fallbackStart,
    oldCount,
    newStart: newStart ?? fallbackStart,
    newCount,
  });
}
