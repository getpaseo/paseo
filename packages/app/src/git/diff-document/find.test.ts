import { describe, expect, it, vi } from "vitest";
import * as findModule from "./find";
import {
  diffFindHeaderMatchesForFile,
  diffFindRectanglesForRowRange,
  findDiffMatches,
  resolveDiffMatchGeometry,
  selectedSingleLineDiffText,
} from "./find";
import { DiffFindModel } from "./find-model.web";
import { buildDiffDocumentModel } from "./model";
import type { BuildDiffDocumentModelInput, DiffPalette } from "./types";

const palette: DiffPalette = {
  surface: "#ffffff",
  headerSurface: "#fafafa",
  border: "#e4e4e7",
  foreground: "#18181b",
  foregroundMuted: "#71717a",
  addition: "#16a34a",
  deletion: "#dc2626",
  additionBackground: "#dcfce7",
  deletionBackground: "#fee2e2",
  emptyBackground: "#ffffff",
  selection: "#3b82f6",
  headerActiveSurface: "#f4f4f5",
  headerBorder: "#e4e4e7",
  statusSuccess: "#16a34a",
  statusDanger: "#dc2626",
  statusWarning: "#f59e0b",
  syntax: {},
};

function createModel(overrides: Partial<BuildDiffDocumentModelInput> = {}) {
  return buildDiffDocumentModel({
    files: [
      {
        path: "src/example.ts",
        isNew: false,
        isDeleted: false,
        additions: 2,
        deletions: 1,
        hunks: [
          {
            oldStart: 1,
            oldCount: 2,
            newStart: 1,
            newCount: 3,
            lines: [
              { type: "header", content: "@@ -1,2 +1,3 @@" },
              { type: "context", content: "const host = 'a.b';" },
              { type: "remove", content: "const oldVal = 'axb';" },
              { type: "add", content: "const newVal = 'A.B';" },
              {
                type: "add",
                content: `${"x".repeat(60)} tail_a.b_end`,
              },
            ],
          },
        ],
      },
    ],
    collapsedFilePaths: new Set(),
    layout: "unified",
    wrapLines: false,
    viewportWidth: 320,
    typography: { family: "monospace", size: 12, lineHeight: 18 },
    measureText: { measure: (text) => text.length * 7 },
    palette,
    labels: { binary: "Binary", tooLarge: "Too large" },
    ...overrides,
  });
}

describe("diff-document find", () => {
  it("matches literal case-insensitive substrings across unified and split layouts, including unmaterialized offscreen rows", () => {
    const unmaterialized = createModel({
      materializationWindow: { top: 0, height: 10 },
    });
    const result = findDiffMatches(unmaterialized, "a.b");
    expect(result.limited).toBe(false);
    expect(result.matches.map((match) => [match.rowIndex, match.start, match.end])).toEqual([
      [1, 14, 17],
      [3, 16, 19],
      [4, 66, 69],
    ]);

    const split = createModel({ layout: "split" });
    const splitResult = findDiffMatches(split, "a.b");
    expect(splitResult.matches).toHaveLength(4);

    const capped = findDiffMatches(unmaterialized, "a.b", 2);
    expect(capped.matches).toHaveLength(2);
    expect(capped.limited).toBe(true);
  });

  it("seeds only single-cell non-empty selections", () => {
    const model = createModel();
    expect(
      selectedSingleLineDiffText(model, {
        anchor: { fileIndex: 0, rowIndex: 1, cellIndex: 0, side: "new", sourceOffset: 6 },
        focus: { fileIndex: 0, rowIndex: 1, cellIndex: 0, side: "new", sourceOffset: 10 },
      }),
    ).toBe("host");

    expect(
      selectedSingleLineDiffText(model, {
        anchor: { fileIndex: 0, rowIndex: 1, cellIndex: 0, side: "new", sourceOffset: 0 },
        focus: { fileIndex: 0, rowIndex: 2, cellIndex: 0, side: "old", sourceOffset: 5 },
      }),
    ).toBeNull();
  });

  it("computes passive and active highlight rectangles across wrapped fragments and horizontal overflow", () => {
    const wrapped = createModel({ wrapLines: true, viewportWidth: 200 });
    const found = findDiffMatches(wrapped, "a.b");
    const rectangles = diffFindRectanglesForRowRange({
      model: wrapped,
      find: { matches: found.matches, activeIndex: 2 },
      rowStart: 0,
      rowEnd: wrapped.rows.length,
    });
    expect(rectangles).toHaveLength(3);
    expect(rectangles.map((rect) => rect.active)).toEqual([false, false, true]);
    expect(rectangles[2]!.y).toBeGreaterThan(wrapped.rows[4]!.top);

    const unwrapped = createModel({ wrapLines: false, viewportWidth: 220 });
    const unwrappedMatches = findDiffMatches(unwrapped, "a.b");
    const tailGeo = resolveDiffMatchGeometry(unwrapped, unwrappedMatches.matches[2]!);
    expect(tailGeo?.materialized).toBe(true);
    expect(tailGeo!.desiredHorizontalOffset(0)).toBeGreaterThan(100);
  });

  it("notifies external-store subscribers on initial empty open, query updates, navigation, and close", () => {
    const doc = createModel();
    const requestPaint = vi.fn();
    const findModel = new DiffFindModel({
      getModel: () => doc,
      getSelection: () => null,
      getRoot: () => null,
      getScroll: () => null,
      setScrollTop: () => undefined,
      getHorizontalOffset: () => 0,
      setHorizontalOffset: () => undefined,
      requestPaint,
    });
    const snapshots: Array<ReturnType<typeof findModel.getSnapshot>> = [];
    const unsubscribe = findModel.subscribe(() => {
      snapshots.push(findModel.getSnapshot());
    });

    findModel.open();
    expect(snapshots.at(-1)).toMatchObject({ open: true, query: "", current: 0, total: 0 });

    findModel.setSearch("no-such-needle");
    expect(snapshots.at(-1)).toMatchObject({
      open: true,
      query: "no-such-needle",
      current: 0,
      total: 0,
    });

    findModel.setSearch("a.b");
    expect(snapshots.at(-1)).toMatchObject({ open: true, query: "a.b", current: 1, total: 3 });

    findModel.previous();
    expect(snapshots.at(-1)).toMatchObject({ current: 3, total: 3 });

    findModel.next();
    expect(snapshots.at(-1)).toMatchObject({ current: 1, total: 3 });

    findModel.close();
    expect(snapshots.at(-1)).toMatchObject({ open: false, query: "a.b", current: 0, total: 0 });
    expect(findModel.getHighlightState()).toBeNull();

    unsubscribe();
  });

  it("matches file header paths (including collapsed files) in reading order before file rows", () => {
    const model = createModel({
      files: [
        {
          path: "src/example.ts",
          isNew: false,
          isDeleted: false,
          additions: 1,
          deletions: 0,
          hunks: [
            {
              oldStart: 1,
              oldCount: 1,
              newStart: 1,
              newCount: 1,
              lines: [
                { type: "header", content: "@@ -1,1 +1,1 @@" },
                { type: "add", content: "// see example.ts" },
              ],
            },
          ],
        },
        {
          path: "docs/collapsed-example.md",
          isNew: true,
          isDeleted: false,
          additions: 1,
          deletions: 0,
          hunks: [
            {
              oldStart: 0,
              oldCount: 0,
              newStart: 1,
              newCount: 1,
              lines: [{ type: "add", content: "hidden example body" }],
            },
          ],
        },
      ],
      collapsedFilePaths: new Set(["docs/collapsed-example.md"]),
    });

    const result = findDiffMatches(model, "example");
    expect(
      result.matches.map((match) => ({
        kind: match.kind,
        fileIndex: match.fileIndex,
        path: match.path,
        start: match.start,
        end: match.end,
      })),
    ).toEqual([
      { kind: "header", fileIndex: 0, path: "src/example.ts", start: 4, end: 11 },
      { kind: "cell", fileIndex: 0, path: "src/example.ts", start: 7, end: 14 },
      { kind: "header", fileIndex: 1, path: "docs/collapsed-example.md", start: 15, end: 22 },
    ]);

    expect(diffFindHeaderMatchesForFile({ matches: result.matches, activeIndex: 2 }, 1)).toEqual([
      { start: 15, end: 22, active: true },
    ]);

    const collapsedHeaderGeo = resolveDiffMatchGeometry(model, result.matches[2]!);
    expect(collapsedHeaderGeo).toMatchObject({
      top: model.files[1]!.top,
      bottom: model.files[1]!.top + model.files[1]!.headerHeight,
      materialized: true,
    });
  });

  it("skips rescanning diff text on scroll/materialization model rebuilds until content or collapse state changes", () => {
    const files: BuildDiffDocumentModelInput["files"] = [
      {
        path: "src/example.ts",
        isNew: false,
        isDeleted: false,
        additions: 1,
        deletions: 0,
        hunks: [
          {
            oldStart: 1,
            oldCount: 0,
            newStart: 1,
            newCount: 1,
            lines: [{ type: "add", content: "const needle = 1;" }],
          },
        ],
      },
    ];
    let currentDoc = createModel({
      files,
      materializationWindow: { top: 0, height: 10 },
    });
    const spy = vi.spyOn(findModule, "findDiffMatches");
    const findModel = new DiffFindModel({
      getModel: () => currentDoc,
      getSelection: () => null,
      getRoot: () => null,
      getScroll: () => null,
      setScrollTop: () => undefined,
      getHorizontalOffset: () => 0,
      setHorizontalOffset: () => undefined,
      requestPaint: () => undefined,
    });

    findModel.open();
    findModel.setSearch("needle");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(findModel.getSnapshot()).toMatchObject({ current: 1, total: 1 });

    // Rebuild with a different materializationWindow (simulating scroll) — same file refs & collapse state
    currentDoc = createModel({
      files,
      materializationWindow: { top: 0, height: 400 },
    });
    findModel.onModelUpdated();
    expect(spy).toHaveBeenCalledTimes(1);

    // Collapsing the file changes searchable content -> triggers rescan
    currentDoc = createModel({
      files,
      collapsedFilePaths: new Set(["src/example.ts"]),
    });
    findModel.onModelUpdated();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(findModel.getSnapshot()).toMatchObject({ current: 0, total: 0 });

    spy.mockRestore();
  });
});
