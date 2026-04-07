import type { DiffHunk } from "@/hooks/use-checkout-diff-query";
import {
  buildChangeBlockReferenceRange,
  buildContextReferenceRange,
  buildHunkLinePositions,
  findContiguousChangeBlock,
} from "./diff-chat-reference";

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

  const positions = buildHunkLinePositions(hunk);
  const contextRange = buildContextReferenceRange({
    hunk,
    positions,
    lineIndex,
  });
  if (contextRange) {
    return buildDiffRangeChatReference({
      path,
      ...contextRange,
    });
  }

  const changeBlock = findContiguousChangeBlock({
    hunk,
    lineIndex,
  });
  if (!changeBlock) {
    return buildHunkChatReference({ path, hunk });
  }

  const range = buildChangeBlockReferenceRange({
    hunk,
    positions,
    ...changeBlock,
  });
  if (!range) {
    return buildHunkChatReference({ path, hunk });
  }

  return buildDiffRangeChatReference({
    path,
    ...range,
  });
}
