import { describe, expect, it } from "vitest";
import {
  buildReviewableDiffTargetKey,
  buildSplitDiffRows,
  buildUnifiedDiffLines,
} from "./diff-layout";
import type { ParsedDiffFile } from "@/git/use-diff-query";
import type { ReviewableDiffTarget } from "./diff-layout";

function makeFile(
  lines: ParsedDiffFile["hunks"][number]["lines"],
  options: { oldStart?: number; newStart?: number } = {},
): ParsedDiffFile {
  const oldStart = options.oldStart ?? 10;
  const newStart = options.newStart ?? 10;
  return {
    path: "example.ts",
    isNew: false,
    isDeleted: false,
    additions: lines.filter((line) => line.type === "add").length,
    deletions: lines.filter((line) => line.type === "remove").length,
    status: "ok",
    hunks: [
      {
        oldStart,
        oldCount: 4,
        newStart,
        newCount: 5,
        lines,
      },
    ],
  };
}

function expectReviewTarget(
  target: ReviewableDiffTarget | null | undefined,
  expected: Omit<ReviewableDiffTarget, "key" | "filePath">,
) {
  expect(target).toMatchObject({
    filePath: "example.ts",
    ...expected,
  });
  expect(target?.key).toBe(
    buildReviewableDiffTargetKey({
      filePath: "example.ts",
      side: expected.side,
      lineNumber: expected.lineNumber,
    }),
  );
}

describe("buildSplitDiffRows", () => {
  it("uses one canonical persisted key for rendered review targets", () => {
    const rows = buildSplitDiffRows(
      makeFile([
        { type: "header", content: "@@ -10,1 +20,1 @@" },
        { type: "context", content: "same line" },
      ]),
    );

    if (rows[1]?.kind !== "pair") {
      throw new Error("Expected split pair row");
    }
    expect(rows[1].left?.reviewTarget?.key).toBe("example.ts:old:10");
    expect(rows[1].right?.reviewTarget?.key).toBe("example.ts:new:10");
  });

  it("pairs replacement runs by index", () => {
    const rows = buildSplitDiffRows(
      makeFile([
        { type: "header", content: "@@ -10,2 +10,2 @@" },
        { type: "remove", content: "before one" },
        { type: "remove", content: "before two" },
        { type: "add", content: "after one" },
        { type: "add", content: "after two" },
      ]),
    );

    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({
      kind: "pair",
      left: { type: "remove", content: "before one", lineNumber: 10 },
      right: { type: "add", content: "after one", lineNumber: 10 },
    });
    expect(rows[2]).toMatchObject({
      kind: "pair",
      left: { type: "remove", content: "before two", lineNumber: 11 },
      right: { type: "add", content: "after two", lineNumber: 11 },
    });
  });

  it("keeps unmatched additions on the right side only", () => {
    const rows = buildSplitDiffRows(
      makeFile([
        { type: "header", content: "@@ -10,1 +10,2 @@" },
        { type: "remove", content: "before" },
        { type: "add", content: "after one" },
        { type: "add", content: "after two" },
      ]),
    );

    expect(rows[2]).toMatchObject({
      kind: "pair",
      left: null,
      right: { type: "add", content: "after two", lineNumber: 11 },
    });
  });

  it("duplicates context rows on both sides", () => {
    const rows = buildSplitDiffRows(
      makeFile([
        { type: "header", content: "@@ -10,1 +10,1 @@" },
        { type: "context", content: "same line" },
      ]),
    );

    expect(rows[1]).toMatchObject({
      kind: "pair",
      left: { type: "context", content: "same line", lineNumber: 10 },
      right: { type: "context", content: "same line", lineNumber: 10 },
    });
  });

  it("emits old and new review targets for split context cells", () => {
    const rows = buildSplitDiffRows(
      makeFile(
        [
          { type: "header", content: "@@ -10,1 +20,1 @@" },
          { type: "context", content: "same line" },
        ],
        { newStart: 20 },
      ),
    );

    expect(rows[0]).toEqual({
      kind: "header",
      content: "@@ -10,1 +20,1 @@",
    });
    expect(rows[1]).toMatchObject({
      kind: "pair",
      left: { type: "context", content: "same line", lineNumber: 10 },
      right: { type: "context", content: "same line", lineNumber: 20 },
    });
    if (rows[1]?.kind !== "pair") {
      throw new Error("Expected split pair row");
    }
    expectReviewTarget(rows[1].left?.reviewTarget, {
      hunkHeader: "@@ -10,1 +20,1 @@",
      hunkIndex: 0,
      lineIndex: 1,
      oldLineNumber: 10,
      newLineNumber: 20,
      side: "old",
      lineNumber: 10,
      lineType: "context",
      content: "same line",
    });
    expectReviewTarget(rows[1].right?.reviewTarget, {
      hunkHeader: "@@ -10,1 +20,1 @@",
      hunkIndex: 0,
      lineIndex: 1,
      oldLineNumber: 10,
      newLineNumber: 20,
      side: "new",
      lineNumber: 20,
      lineType: "context",
      content: "same line",
    });
  });

  it("does not emit review targets for split headers or empty cells", () => {
    const rows = buildSplitDiffRows(
      makeFile([
        { type: "header", content: "@@ -10,1 +10,2 @@" },
        { type: "add", content: "after" },
      ]),
    );

    expect(rows[0]).toEqual({
      kind: "header",
      content: "@@ -10,1 +10,2 @@",
    });
    expect(rows[1]).toMatchObject({
      kind: "pair",
      left: null,
      right: { type: "add", content: "after", lineNumber: 10 },
    });
    if (rows[1]?.kind !== "pair") {
      throw new Error("Expected split pair row");
    }
    expectReviewTarget(rows[1].right?.reviewTarget, {
      hunkHeader: "@@ -10,1 +10,2 @@",
      hunkIndex: 0,
      lineIndex: 1,
      oldLineNumber: null,
      newLineNumber: 10,
      side: "new",
      lineNumber: 10,
      lineType: "add",
      content: "after",
    });
  });
});

describe("buildUnifiedDiffLines", () => {
  it("computes line numbers per line type within a hunk", () => {
    const lines = buildUnifiedDiffLines(
      makeFile([
        { type: "header", content: "@@ -10,3 +10,4 @@" },
        { type: "context", content: "before" },
        { type: "add", content: "inserted" },
        { type: "remove", content: "removed" },
        { type: "context", content: "after" },
      ]),
    );

    expect(
      lines.map(({ line, lineNumber }) => ({
        type: line.type,
        lineNumber,
        content: line.content,
      })),
    ).toEqual([
      { type: "header", lineNumber: null, content: "@@ -10,3 +10,4 @@" },
      { type: "context", lineNumber: 10, content: "before" },
      { type: "add", lineNumber: 11, content: "inserted" },
      { type: "remove", lineNumber: 11, content: "removed" },
      { type: "context", lineNumber: 12, content: "after" },
    ]);
  });

  it("restarts numbering at each hunk boundary", () => {
    const file: ParsedDiffFile = {
      path: "example.ts",
      isNew: false,
      isDeleted: false,
      additions: 1,
      deletions: 0,
      status: "ok",
      hunks: [
        {
          oldStart: 75,
          oldCount: 2,
          newStart: 75,
          newCount: 3,
          lines: [
            { type: "header", content: "@@ -75,2 +75,3 @@" },
            { type: "context", content: "first" },
            { type: "add", content: "inserted" },
            { type: "context", content: "second" },
          ],
        },
        {
          oldStart: 165,
          oldCount: 2,
          newStart: 166,
          newCount: 2,
          lines: [
            { type: "header", content: "@@ -165,2 +166,2 @@" },
            { type: "context", content: "third" },
            { type: "context", content: "fourth" },
          ],
        },
      ],
    };

    const lines = buildUnifiedDiffLines(file);

    expect(lines[0]?.lineNumber).toBeNull();
    expect(lines[1]?.lineNumber).toBe(75);
    expect(lines[3]?.lineNumber).toBe(77);
    expect(lines[4]?.lineNumber).toBeNull();
    expect(lines[5]?.lineNumber).toBe(166);
    expect(lines[6]?.lineNumber).toBe(167);
  });

  it("emits canonical review targets for unified add, remove, and context lines", () => {
    const lines = buildUnifiedDiffLines(
      makeFile(
        [
          { type: "header", content: "@@ -10,2 +20,2 @@" },
          { type: "context", content: "before" },
          { type: "remove", content: "removed" },
          { type: "add", content: "inserted" },
        ],
        { newStart: 20 },
      ),
    );

    expect(lines[0]?.reviewTarget).toBeNull();
    expectReviewTarget(lines[1]?.reviewTarget, {
      hunkHeader: "@@ -10,2 +20,2 @@",
      hunkIndex: 0,
      lineIndex: 1,
      oldLineNumber: 10,
      newLineNumber: 20,
      side: "new",
      lineNumber: 20,
      lineType: "context",
      content: "before",
    });
    expectReviewTarget(lines[2]?.reviewTarget, {
      hunkHeader: "@@ -10,2 +20,2 @@",
      hunkIndex: 0,
      lineIndex: 2,
      oldLineNumber: 11,
      newLineNumber: null,
      side: "old",
      lineNumber: 11,
      lineType: "remove",
      content: "removed",
    });
    expectReviewTarget(lines[3]?.reviewTarget, {
      hunkHeader: "@@ -10,2 +20,2 @@",
      hunkIndex: 0,
      lineIndex: 3,
      oldLineNumber: null,
      newLineNumber: 21,
      side: "new",
      lineNumber: 21,
      lineType: "add",
      content: "inserted",
    });
  });
});
