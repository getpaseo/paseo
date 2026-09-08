import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  characterOffsetAtPoint,
  hitTestDiffDocument,
  orderedSelection,
  selectAllSource,
  selectCellSource,
  selectedSourceText,
} from "./hit-testing";
import { buildDiffDocumentModel } from "./model";
import type { BuildDiffDocumentModelInput, DiffCell, DiffSelection } from "./types";

const measurer = { measure: (text: string) => Array.from(text).length * 10 };

describe("diff hit testing", () => {
  it("locates the closest character from measured wrapped geometry", () => {
    const cell = changedCell(buildModel("abcdef", { viewportWidth: 90 }));
    expect(characterOffsetAtPoint({ cell, x: 6, y: 20, lineHeight: 18 })).toBe(5);
  });

  it("never places a character hit inside combining or ZWJ graphemes", () => {
    const cell = changedCell(buildModel("a👨‍👩‍👧‍👦éb", { viewportWidth: 300 }));
    const emoji = cell.fragments[0]?.graphemes.find((grapheme) => grapheme.text.includes("👨"));
    const combining = cell.fragments[0]?.graphemes.find((grapheme) => grapheme.text === "é");
    expect(emoji).toBeDefined();
    expect(combining).toBeDefined();
    expect([emoji?.start, emoji?.end]).toContain(
      characterOffsetAtPoint({ cell, x: 15, y: 0, lineHeight: 18 }),
    );
    const combiningIndex = cell.fragments[0]!.graphemes.indexOf(combining!);
    const beforeCombining = cell.fragments[0]!.graphemes.slice(0, combiningIndex).reduce(
      (width, grapheme) => width + grapheme.width,
      0,
    );
    expect(
      characterOffsetAtPoint({
        cell,
        x: beforeCombining + combining!.width / 2 + 1,
        y: 0,
        lineHeight: 18,
      }),
    ).toBe(combining?.end);
  });

  it("normalizes backwards selection and copies exact source including empty lines", () => {
    const model = buildModel("", { wrapLines: false });
    const cell = changedCell(model);
    const nextCell = model.rows
      .filter((row) => row.kind === "line")
      .flatMap((row) => row.cells)
      .find((candidate) => candidate?.content === "tail");
    expect(nextCell).toBeDefined();
    const selection: DiffSelection = {
      anchor: position(model, nextCell!, nextCell!.content.length),
      focus: position(model, cell, 0),
    };
    expect(orderedSelection(selection).start.sourceOffset).toBe(0);
    expect(selectedSourceText(model, selection)).toBe("\ntail");
  });

  it("serializes exact canonical source for forward and backward wrapped selections", () => {
    const model = buildModel("A\t中👨‍👩‍👧‍👦éZ", { viewportWidth: 90 });
    const cell = changedCell(model);
    const start = position(model, cell, 1);
    const end = position(model, cell, cell.content.length - 1);
    expect(selectedSourceText(model, { anchor: start, focus: end })).toBe("\t中👨‍👩‍👧‍👦é");
    expect(selectedSourceText(model, { anchor: end, focus: start })).toBe("\t中👨‍👩‍👧‍👦é");
  });

  it("serializes one split side without interleaving the opposite side", () => {
    const model = buildModel("unused", { files: [splitFile()], layout: "split" });
    const lineRows = model.rows.filter(
      (row) => row.kind === "line" && row.cells.length === 2 && row.cells.every(Boolean),
    );
    const first = lineRows[0];
    const second = lineRows[1];
    expect(first?.kind).toBe("line");
    expect(second?.kind).toBe("line");
    const firstRight = first!.kind === "line" ? first!.cells[1]! : null;
    const secondRight = second!.kind === "line" ? second!.cells[1]! : null;
    expect(firstRight).not.toBeNull();
    expect(secondRight).not.toBeNull();
    const selection = {
      anchor: position(model, firstRight!, 1),
      focus: position(model, secondRight!, secondRight!.content.length),
    };
    expect(selectedSourceText(model, selection)).toBe("ew-one\nnew-two");
    expect(selectedSourceText(model, { anchor: selection.focus, focus: selection.anchor })).toBe(
      "ew-one\nnew-two",
    );
  });

  it("does not hit-test reserved review geometry as source text", () => {
    const model = buildModel("review me", { reviewActions: reviewActionsForFirstAddition() });
    const row = model.rows.find(
      (candidate) => candidate.kind === "line" && candidate.reviewHeight > 0,
    );
    expect(row?.kind).toBe("line");
    expect(
      hitTestDiffDocument({
        model,
        x: 20,
        documentY: row!.top + row!.height - 1,
        horizontalOffset: 0,
      }),
    ).toBeNull();
  });

  it("selects one source line for context-menu copy", () => {
    const model = buildModel("copy this", { wrapLines: false });
    const cell = changedCell(model);

    expect(selectedSourceText(model, selectCellSource(model, position(model, cell, 4)))).toBe(
      "copy this",
    );
  });

  it("selects all diff source in document order", () => {
    const model = buildModel("first", { wrapLines: false });

    expect(selectedSourceText(model, selectAllSource(model)!)).toBe("@@ -1,0 +1,2 @@\nfirst\ntail");
  });

  it("selects all source from one split side without interleaving panes", () => {
    const model = buildModel("unused", { files: [splitFile()], layout: "split" });
    const changedRow = model.rows.find(
      (row) => row.kind === "line" && row.cells.length === 2 && row.cells.every(Boolean),
    );
    expect(changedRow?.kind).toBe("line");

    const left = changedRow!.kind === "line" ? changedRow!.cells[0]! : null;
    const right = changedRow!.kind === "line" ? changedRow!.cells[1]! : null;
    expect(selectedSourceText(model, selectAllSource(model, position(model, left!, 0))!)).toBe(
      "@@ -1,2 +1,2 @@\nold-one\nold-two",
    );
    expect(selectedSourceText(model, selectAllSource(model, position(model, right!, 0))!)).toBe(
      "new-one\nnew-two",
    );
  });

  it("defaults split hunk-header select-all to the new pane", () => {
    const model = buildModel("unused", { files: [splitFile()], layout: "split" });
    const header = model.rows
      .filter((row) => row.kind === "line")
      .flatMap((row) => row.cells)
      .find((cell) => cell?.type === "header");
    expect(header).toBeDefined();

    expect(selectedSourceText(model, selectAllSource(model, position(model, header!, 0))!)).toBe(
      "new-one\nnew-two",
    );
  });

  it("falls back to the old pane for a deletion-only split hunk", () => {
    const model = buildModel("unused", { files: [deletedSplitFile()], layout: "split" });
    const header = model.rows
      .filter((row) => row.kind === "line")
      .flatMap((row) => row.cells)
      .find((cell) => cell?.type === "header");
    expect(header).toBeDefined();

    expect(selectedSourceText(model, selectAllSource(model, position(model, header!, 0))!)).toBe(
      "@@ -1,2 +1,0 @@\nold-one\nold-two",
    );
  });
});

function buildModel(changedContent: string, overrides: Partial<BuildDiffDocumentModelInput> = {}) {
  const file: ParsedDiffFile = {
    path: "src/a.ts",
    isNew: false,
    isDeleted: false,
    additions: 2,
    deletions: 0,
    hunks: [
      {
        oldStart: 1,
        oldCount: 0,
        newStart: 1,
        newCount: 2,
        lines: [
          { type: "header", content: "@@ -1,0 +1,2 @@" },
          { type: "add", content: changedContent },
          { type: "add", content: "tail" },
        ],
      },
    ],
  };
  return buildDiffDocumentModel({
    files: [file],
    collapsedFilePaths: new Set(),
    layout: "unified",
    wrapLines: true,
    viewportWidth: 180,
    typography: { family: "monospace", size: 12, lineHeight: 18 },
    measureText: measurer,
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
      headerActiveSurface: "#222",
      headerBorder: "#333",
      statusSuccess: "green",
      statusDanger: "red",
      statusWarning: "orange",
      syntax: {},
    },
    labels: { binary: "Binary", tooLarge: "Too large" },
    ...overrides,
  });
}

function changedCell(model: ReturnType<typeof buildModel>): DiffCell {
  const cell = model.rows
    .filter((row) => row.kind === "line")
    .flatMap((row) => row.cells)
    .find((candidate) => candidate?.type === "add");
  if (!cell) throw new Error("Expected an added cell");
  return cell;
}

function position(
  model: ReturnType<typeof buildModel>,
  cell: DiffCell,
  cellOffset: number,
): DiffSelection["anchor"] {
  const row = model.rows.find(
    (candidate) => candidate.kind === "line" && candidate.cells.includes(cell),
  );
  if (!row || row.kind !== "line") throw new Error("Expected cell row");
  const cellIndex = row.cells.indexOf(cell);
  return {
    fileIndex: row.fileIndex,
    rowIndex: row.index,
    cellIndex,
    side: cell.reviewTarget?.side ?? (cellIndex === 0 ? "old" : "new"),
    sourceOffset: cellOffset,
  };
}

function splitFile(): ParsedDiffFile {
  return {
    path: "src/split.ts",
    isNew: false,
    isDeleted: false,
    additions: 2,
    deletions: 2,
    hunks: [
      {
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 2,
        lines: [
          { type: "header", content: "@@ -1,2 +1,2 @@" },
          { type: "remove", content: "old-one" },
          { type: "remove", content: "old-two" },
          { type: "add", content: "new-one" },
          { type: "add", content: "new-two" },
        ],
      },
    ],
  };
}

function deletedSplitFile(): ParsedDiffFile {
  return {
    path: "src/deleted.ts",
    isNew: false,
    isDeleted: true,
    additions: 0,
    deletions: 2,
    hunks: [
      {
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 0,
        lines: [
          { type: "header", content: "@@ -1,2 +1,0 @@" },
          { type: "remove", content: "old-one" },
          { type: "remove", content: "old-two" },
        ],
      },
    ],
  };
}

function reviewActionsForFirstAddition(): NonNullable<
  BuildDiffDocumentModelInput["reviewActions"]
> {
  const target = {
    key: "src/a.ts:new:1",
    filePath: "src/a.ts",
    hunkHeader: "@@ -1,0 +1,2 @@",
    hunkIndex: 0,
    lineIndex: 1,
    oldLineNumber: null,
    newLineNumber: 1,
    side: "new" as const,
    lineNumber: 1,
    lineType: "add" as const,
    content: "review me",
  };
  return {
    commentsByTarget: new Map(),
    editor: { target, commentId: null, body: "" },
    onStartComment() {},
    onCancelEditor() {},
    onSaveEditor() {},
    onEditComment() {},
    onDeleteComment() {},
  };
}
