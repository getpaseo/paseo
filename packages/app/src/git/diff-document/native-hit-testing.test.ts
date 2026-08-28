import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { buildDiffDocumentModel } from "./model";
import { hitTestDiffBodyPoint } from "./native-hit-testing";
import type { BuildDiffDocumentModelInput } from "./types";

describe("native diff body-coordinate hit testing", () => {
  it("resolves first and later files from their body-local coordinates", () => {
    const model = build("unified");
    const rows = model.rows.filter((row) => row.kind === "line" && row.cells[0]?.type === "add");
    for (const row of rows) {
      const file = model.files[row.fileIndex]!;
      const hit = hitTestDiffBodyPoint({
        model,
        file,
        locationX: file.gutterWidth + 18,
        locationY: row.top - file.bodyTop + 2,
        horizontalOffset: 0,
      });
      expect(hit?.kind).toBe("cell");
      if (hit?.kind === "cell") expect(hit.position.fileIndex).toBe(row.fileIndex);
    }
  });

  it("keeps a later expanded file interactive after an earlier body grows", () => {
    const model = build("unified");
    const target = model.rows.find(
      (row) => row.kind === "line" && row.fileIndex === 1 && row.cells[0]?.type === "add",
    )!;
    const file = model.files[1]!;

    const hit = hitTestDiffBodyPoint({
      model,
      file,
      locationX: file.gutterWidth + 18,
      locationY: target.top - file.bodyTop + 2,
      horizontalOffset: 0,
    });

    expect(hit?.kind === "cell" ? hit.position.fileIndex : null).toBe(1);
  });

  it("applies the touched file's retained horizontal offset", () => {
    const model = build("unified");
    const row = model.rows.find(
      (candidate) =>
        candidate.kind === "line" &&
        candidate.path === "src/second.ts" &&
        candidate.cells[0]?.type === "add",
    )!;
    const file = model.files[1]!;
    const hit = hitTestDiffBodyPoint({
      model,
      file,
      locationX: file.gutterWidth + 8,
      locationY: row.top - file.bodyTop + 2,
      horizontalOffset: 30,
    });
    expect(hit?.kind === "cell" ? hit.position.sourceOffset : -1).toBe(3);
  });

  it("resolves old and new split cells from body-local coordinates", () => {
    const model = build("split");
    const row = model.rows.find(
      (candidate) =>
        candidate.kind === "line" && candidate.cells.length === 2 && candidate.cells.every(Boolean),
    )!;
    const left = hitAt(model, row.top, model.viewportWidth * 0.25);
    const right = hitAt(model, row.top, model.viewportWidth * 0.75);
    expect(left?.kind === "cell" ? left.position.side : null).toBe("old");
    expect(right?.kind === "cell" ? right.position.side : null).toBe("new");
  });
});

function hitAt(model: ReturnType<typeof buildDiffDocumentModel>, rowTop: number, x: number) {
  const file = model.files.find((entry) => entry.bodyTop <= rowTop && rowTop < entry.bottom)!;
  return hitTestDiffBodyPoint({
    model,
    file,
    locationX: x,
    locationY: rowTop - file.bodyTop + 2,
    horizontalOffset: 0,
  });
}

function build(layout: "unified" | "split") {
  const input: BuildDiffDocumentModelInput = {
    files: [
      diffFile("src/first.ts", "first-long-content"),
      diffFile("src/second.ts", "second-long-content"),
    ],
    collapsedFilePaths: new Set(),
    layout,
    wrapLines: false,
    viewportWidth: 400,
    typography: { family: "monospace", size: 12, lineHeight: 18 },
    measureText: { measure: (text) => Array.from(text).length * 10 },
    palette: {
      surface: "#000",
      headerSurface: "#111",
      border: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      addition: "green",
      deletion: "red",
      additionBackground: "#010",
      deletionBackground: "#100",
      emptyBackground: "#111",
      selection: "blue",
      syntax: {},
    },
    labels: { binary: "Binary", tooLarge: "Too large" },
  };
  return buildDiffDocumentModel(input);
}

function diffFile(path: string, content: string): ParsedDiffFile {
  return {
    path,
    isNew: false,
    isDeleted: false,
    additions: 1,
    deletions: 1,
    hunks: [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 1,
        lines: [
          { type: "header", content: "@@ -1 +1 @@" },
          { type: "remove", content },
          { type: "add", content },
        ],
      },
    ],
  };
}
