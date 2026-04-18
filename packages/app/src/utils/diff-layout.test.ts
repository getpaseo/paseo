import { describe, expect, it } from "vitest";
import { buildSplitDiffRows, buildUnifiedDiffLines } from "./diff-layout";
import type { ParsedDiffFile } from "@/hooks/use-checkout-diff-query";

function makeFile(lines: ParsedDiffFile["hunks"][number]["lines"]): ParsedDiffFile {
  return {
    path: "example.ts",
    isNew: false,
    isDeleted: false,
    additions: lines.filter((line) => line.type === "add").length,
    deletions: lines.filter((line) => line.type === "remove").length,
    status: "ok",
    hunks: [
      {
        oldStart: 10,
        oldCount: 4,
        newStart: 10,
        newCount: 5,
        lines,
      },
    ],
  };
}

describe("buildSplitDiffRows", () => {
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
});
