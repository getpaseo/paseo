import { describe, expect, it } from "vitest";
import { buildSplitDiffRows } from "./diff-layout";
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
      hunkIndex: 0,
      isFirstChangedLineInHunk: true,
      chatReference: "example.ts:10-11",
      left: { type: "remove", content: "before one", lineNumber: 10 },
      right: { type: "add", content: "after one", lineNumber: 10 },
    });
    expect(rows[2]).toMatchObject({
      kind: "pair",
      hunkIndex: 0,
      isFirstChangedLineInHunk: false,
      chatReference: "example.ts:10-11",
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
      hunkIndex: 0,
      isFirstChangedLineInHunk: false,
      chatReference: "example.ts:10-11",
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
      hunkIndex: 0,
      isFirstChangedLineInHunk: false,
      chatReference: "example.ts:10",
      left: { type: "context", content: "same line", lineNumber: 10 },
      right: { type: "context", content: "same line", lineNumber: 10 },
    });
  });

  it("marks the first changed row instead of leading context", () => {
    const rows = buildSplitDiffRows(
      makeFile([
        { type: "header", content: "@@ -10,3 +10,3 @@" },
        { type: "context", content: "same line" },
        { type: "remove", content: "before" },
        { type: "add", content: "after" },
      ]),
    );

    expect(rows[1]).toMatchObject({
      kind: "pair",
      isFirstChangedLineInHunk: false,
      left: { type: "context", content: "same line", lineNumber: 10 },
      right: { type: "context", content: "same line", lineNumber: 10 },
    });
    expect(rows[2]).toMatchObject({
      kind: "pair",
      isFirstChangedLineInHunk: true,
      chatReference: "example.ts:11",
      left: { type: "remove", content: "before", lineNumber: 11 },
      right: { type: "add", content: "after", lineNumber: 11 },
    });
  });

  it("uses surrounding new-side context for delete-only split rows", () => {
    const rows = buildSplitDiffRows(
      {
        path: "example.ts",
        isNew: false,
        isDeleted: false,
        additions: 0,
        deletions: 6,
        status: "ok",
        hunks: [
          {
            oldStart: 237,
            oldCount: 8,
            newStart: 239,
            newCount: 2,
            lines: [
              { type: "header", content: "@@ -237,8 +239,2 @@" },
              { type: "context", content: "before" },
              { type: "remove", content: "deleted one" },
              { type: "remove", content: "deleted two" },
              { type: "remove", content: "deleted three" },
              { type: "remove", content: "deleted four" },
              { type: "remove", content: "deleted five" },
              { type: "remove", content: "deleted six" },
              { type: "context", content: "after" },
            ],
          },
        ],
      },
    );

    expect(rows[2]).toMatchObject({
      kind: "pair",
      chatReference: "example.ts:239-240",
      left: { type: "remove", content: "deleted one", lineNumber: 238 },
      right: null,
    });
    expect(rows[7]).toMatchObject({
      kind: "pair",
      chatReference: "example.ts:239-240",
      left: { type: "remove", content: "deleted six", lineNumber: 243 },
      right: null,
    });
  });
});
