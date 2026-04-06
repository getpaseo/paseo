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
