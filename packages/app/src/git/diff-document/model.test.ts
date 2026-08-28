import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  buildDiffDocumentModel,
  captureScrollAnchor,
  FILE_HEADER_HEIGHT,
  graphemeBoundaries,
  measureFragments,
  resolveScrollAnchor,
  resolveRelayoutScrollTop,
  shouldApplyRelayoutScroll,
} from "./model";
import type { BuildDiffDocumentModelInput, TextMeasurer } from "./types";

const measurer: TextMeasurer = { measure: (text) => Array.from(text).length * 10 };

function file(path = "src/a.ts"): ParsedDiffFile {
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
          { type: "remove", content: "const oldValue = '👨‍👩‍👧‍👦';" },
          { type: "add", content: "const newValue = 'é';" },
        ],
      },
    ],
  };
}

function input(overrides: Partial<BuildDiffDocumentModelInput> = {}): BuildDiffDocumentModelInput {
  return {
    files: [file()],
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
      syntax: {},
    },
    labels: { binary: "Binary", tooLarge: "Too large" },
    ...overrides,
  };
}

describe("diff document model", () => {
  it("does not imperatively scroll for a no-op relayout", () => {
    expect(shouldApplyRelayoutScroll(320, 320)).toBe(false);
    expect(shouldApplyRelayoutScroll(320, 320.4)).toBe(false);
    expect(shouldApplyRelayoutScroll(320, 321)).toBe(true);
  });

  it("segments graphemes when Intl.Segmenter is unavailable", () => {
    const originalSegmenter = Intl.Segmenter;
    Object.defineProperty(Intl, "Segmenter", { configurable: true, value: undefined });
    try {
      const source = "中é👨‍👩‍👧‍👦";
      const fragments = measureFragments({
        text: source,
        availableWidth: 100,
        wrapLines: true,
        lineHeight: 18,
        measureText: measurer,
      });
      expect(fragments[0]?.graphemes.map((grapheme) => grapheme.text)).toEqual(["中", "é", "👨‍👩‍👧‍👦"]);
    } finally {
      Object.defineProperty(Intl, "Segmenter", { configurable: true, value: originalSegmenter });
    }
  });

  it("measures grapheme-safe wrapped fragments", () => {
    const text = "ab👨‍👩‍👧‍👦cd";
    const fragments = measureFragments({
      text,
      availableWidth: 30,
      wrapLines: true,
      lineHeight: 18,
      measureText: measurer,
    });
    const boundaries = new Set(graphemeBoundaries(text));
    expect(fragments.length).toBeGreaterThan(1);
    for (const fragment of fragments) {
      expect(boundaries.has(fragment.start)).toBe(true);
      expect(boundaries.has(fragment.end)).toBe(true);
    }
  });

  it("measures wrapped ligatures in the exact fragment shaping context", () => {
    const ligatureMeasurer = shapingMeasurer(ligatureWidth);

    const fragments = measureFragments({
      text: "xfi",
      availableWidth: 12,
      wrapLines: true,
      lineHeight: 18,
      measureText: ligatureMeasurer,
    });

    expect(fragments.map((fragment) => fragment.text)).toEqual(["x", "fi"]);
    expect(fragments.map((fragment) => fragment.width)).toEqual([10, 12]);
    expect(fragments[1]?.graphemes.map((grapheme) => grapheme.width)).toEqual([8, 4]);
  });

  it("remeasures contextual-script glyphs after wrapping", () => {
    const contextualMeasurer = shapingMeasurer((text) => {
      if (text === "اب") return 15;
      if (text === "ا") return 10;
      if (text === "ب") return 9;
      return 0;
    });

    const fragments = measureFragments({
      text: "اب",
      availableWidth: 10,
      wrapLines: true,
      lineHeight: 18,
      measureText: contextualMeasurer,
    });

    expect(fragments.map((fragment) => fragment.text)).toEqual(["ا", "ب"]);
    expect(fragments.map((fragment) => fragment.width)).toEqual([10, 9]);
    expect(fragments[1]?.graphemes[0]?.width).toBe(9);
  });

  it("expands tabs to stable stops while retaining source offsets", () => {
    const source = "a\tb\t中👨‍👩‍👧‍👦é";
    const model = buildDiffDocumentModel(
      input({ files: [fileWithChangedLine(source)], wrapLines: false }),
    );
    const cell = addedCell(model);
    expect(cell.content).toBe(source);
    expect(cell.fragments[0]?.text).toBe("a   b   中👨‍👩‍👧‍👦é");
    expect(cell.fragments[0]?.graphemes.map((grapheme) => grapheme.text)).toEqual([
      "a",
      "   ",
      "b",
      "   ",
      "中",
      "👨‍👩‍👧‍👦",
      "é",
    ]);
    expect(cell.content).toBe(source);
    expect(cell.fragments[0]?.width).toBe(180);
  });

  it("measures CJK, combining marks, and ZWJ emoji as fallback-capable grapheme runs", () => {
    const model = buildDiffDocumentModel(
      input({
        files: [fileWithChangedLine("中é👨‍👩‍👧‍👦")],
      }),
    );
    expect(addedCell(model).fragments[0]?.graphemes.map((grapheme) => grapheme.text)).toEqual([
      "中",
      "é",
      "👨‍👩‍👧‍👦",
    ]);
  });

  it("removes collapsed bodies and leaves future files expanded by default", () => {
    const expanded = buildDiffDocumentModel(input({ files: [file("a.ts"), file("b.ts")] }));
    const collapsed = buildDiffDocumentModel(
      input({ files: [file("a.ts"), file("b.ts")], collapsedFilePaths: new Set(["a.ts"]) }),
    );
    expect(collapsed.files[0]?.bodyHeight).toBe(0);
    expect(collapsed.files[1]?.bodyHeight).toBeGreaterThan(0);
    expect(collapsed.height).toBeLessThan(expanded.height);
  });

  it("reuses unchanged file measurements when collapse state changes", () => {
    const files = [file("a.ts"), file("b.ts")];
    let measurementCount = 0;
    const countingMeasurer: TextMeasurer = {
      measure(text) {
        measurementCount += 1;
        return Array.from(text).length * 10;
      },
    };
    const expanded = buildDiffDocumentModel(input({ files, measureText: countingMeasurer }));
    const initialMeasurementCount = measurementCount;

    const collapsed = buildDiffDocumentModel(
      input({
        files,
        collapsedFilePaths: new Set(["a.ts"]),
        measureText: countingMeasurer,
        reuseFrom: [expanded],
      }),
    );

    expect(measurementCount).toBe(initialMeasurementCount);
    expect(collapsed.files[1]?.bodyHeight).toBe(expanded.files[1]?.bodyHeight);
    expect(collapsed.rows.every((row, index) => row.index === index)).toBe(true);
    expect(collapsed.rows[0]?.top).toBe(FILE_HEADER_HEIGHT * 2);

    const expandedAgain = buildDiffDocumentModel(
      input({
        files,
        measureText: countingMeasurer,
        reuseFrom: [expanded, collapsed],
      }),
    );
    expect(measurementCount).toBe(initialMeasurementCount);
    expect(expandedAgain.height).toBe(expanded.height);
  });

  it("keeps the toggled sticky header anchored through collapse and expansion", () => {
    const files = [file("a.ts"), file("b.ts")];
    const expanded = buildDiffDocumentModel(input({ files }));
    const firstFile = expanded.files[0]!;
    const scrollTop = firstFile.top + 20;
    const collapsed = buildDiffDocumentModel(
      input({ files, collapsedFilePaths: new Set(["a.ts"]), reuseFrom: [expanded] }),
    );

    expect(resolveRelayoutScrollTop(expanded, collapsed, scrollTop)).toBe(collapsed.files[0]!.top);
    expect(resolveRelayoutScrollTop(collapsed, expanded, collapsed.files[0]!.top)).toBe(
      expanded.files[0]!.top,
    );
  });

  it("reserves review geometry in the measured row", () => {
    const model = buildDiffDocumentModel(
      input({
        reviewActions: {
          commentsByTarget: new Map(),
          editor: {
            target: {
              key: "src/a.ts:old:1",
              filePath: "src/a.ts",
              hunkHeader: "@@ -1 +1 @@",
              hunkIndex: 0,
              lineIndex: 1,
              oldLineNumber: 1,
              newLineNumber: null,
              side: "old",
              lineNumber: 1,
              lineType: "remove",
              content: "const oldValue = '👨‍👩‍👧‍👦';",
            },
            body: "",
            commentId: null,
          },
          onStartComment() {},
          onCancelEditor() {},
          onSaveEditor() {},
          onEditComment() {},
          onDeleteComment() {},
        },
      }),
    );
    const reviewRow = model.rows.find((row) => {
      if (row.kind !== "line") return false;
      return (
        row.cells[0]?.reviewTarget?.side === "old" || row.cells[1]?.reviewTarget?.side === "old"
      );
    });
    expect(reviewRow?.kind === "line" ? reviewRow.reviewHeight : 0).toBe(148);
  });

  it("reflows review geometry without remeasuring unchanged text", () => {
    const files = [file("a.ts"), file("b.ts")];
    let measurementCount = 0;
    const countingMeasurer: TextMeasurer = {
      measure(text) {
        measurementCount += 1;
        return Array.from(text).length * 10;
      },
    };
    const base = buildDiffDocumentModel(input({ files, measureText: countingMeasurer }));
    const initialMeasurementCount = measurementCount;
    const reviewCell = base.rows
      .filter((row) => row.kind === "line")
      .flatMap((row) => row.cells)
      .find((cell) => cell?.reviewTarget);
    if (!reviewCell?.reviewTarget) throw new Error("Expected a reviewable cell");
    const baseReviewRow = rowForCell(base, reviewCell);
    const baseSecondFileTop = base.files[1]!.top;

    const withEditor = buildDiffDocumentModel(
      input({
        files,
        measureText: countingMeasurer,
        reviewActions: reviewActionsWithEditor(reviewCell.reviewTarget),
        reuseFrom: [base],
      }),
    );
    const editorRow = rowForReviewTarget(withEditor, reviewCell.reviewTarget.key);

    expect(measurementCount).toBe(initialMeasurementCount);
    expect(editorRow.reviewHeight).toBe(148);
    expect(editorRow.cells).toBe(baseReviewRow.cells);
    expect(withEditor.files[1]!.top).toBe(baseSecondFileTop + 148);

    const withoutEditor = buildDiffDocumentModel(
      input({
        files,
        measureText: countingMeasurer,
        reviewActions: reviewActionsWithEditor(null),
        reuseFrom: [base, withEditor],
      }),
    );

    expect(measurementCount).toBe(initialMeasurementCount);
    expect(withoutEditor.height).toBe(base.height);
    expect(withoutEditor.files[1]!.top).toBe(baseSecondFileTop);
  });

  it("preserves a logical source anchor through width and font metric relayout", () => {
    const narrow = buildDiffDocumentModel(
      input({ files: [fileWithChangedLine("abcdefghij")], viewportWidth: 90 }),
    );
    const narrowCell = addedCell(narrow);
    const narrowRow = narrow.rows.find(
      (row) => row.kind === "line" && row.cells.includes(narrowCell),
    );
    expect(narrowRow?.kind).toBe("line");
    expect(narrowCell.fragments.length).toBeGreaterThan(1);
    const scrollTop = narrowRow!.top + narrowCell.fragments[1]!.top + 3;
    const anchor = captureScrollAnchor(narrow, scrollTop);
    expect(anchor?.kind).toBe("text");

    const wide = buildDiffDocumentModel(
      input({
        files: [fileWithChangedLine("abcdefghij")],
        viewportWidth: 300,
        typography: { family: "wide-font", size: 18, lineHeight: 27 },
        measureText: { measure: (text) => Array.from(text).length * 14 },
      }),
    );
    const resolved = resolveScrollAnchor(wide, anchor!);
    const wideCell = addedCell(wide);
    const wideRow = wide.rows.find((row) => row.kind === "line" && row.cells.includes(wideCell));
    const anchoredFragment = wideCell.fragments.find(
      (fragment) =>
        anchor?.kind === "text" &&
        fragment.start <= anchor.cellOffset &&
        anchor.cellOffset < fragment.end,
    );
    expect(resolved).toBe(wideRow!.top + anchoredFragment!.top - anchor!.viewportDelta);

    const wideAnchor = captureScrollAnchor(wide, wideRow!.top + 2);
    const backToNarrow = resolveScrollAnchor(narrow, wideAnchor!);
    const firstNarrowFragment = narrowCell.fragments[0];
    expect(backToNarrow).toBe(
      narrowRow!.top + firstNarrowFragment!.top - wideAnchor!.viewportDelta,
    );
  });

  it("preserves a source-line anchor from unified to split and back", () => {
    const changedFile = fileWithUnevenChanges();
    const unified = buildDiffDocumentModel(
      input({ files: [changedFile], layout: "unified", viewportWidth: 100 }),
    );
    const identity = { hunkIndex: 0, lineIndex: 4, side: "new" } as const;
    const unifiedCell = cellByIdentity(unified, identity);
    const unifiedRow = rowForCell(unified, unifiedCell);
    expect(unifiedCell.fragments.length).toBeGreaterThan(1);
    const anchoredFragment = unifiedCell.fragments[1]!;
    const anchor = captureScrollAnchor(unified, unifiedRow.top + anchoredFragment.top + 2);
    expect(anchor).toMatchObject({
      kind: "text",
      sourceIdentity: identity,
      cellOffset: anchoredFragment.start,
      viewportDelta: -2,
    });

    const split = buildDiffDocumentModel(
      input({ files: [changedFile], layout: "split", viewportWidth: 100 }),
    );
    const splitCell = cellByIdentity(split, identity);
    const splitRow = rowForCell(split, splitCell);
    const splitFragment = splitCell.fragments.find(
      (fragment) =>
        fragment.start <= anchoredFragment.start && anchoredFragment.start < fragment.end,
    );
    expect(resolveScrollAnchor(split, anchor!)).toBe(
      splitRow.top + splitFragment!.top - anchor!.viewportDelta,
    );

    const splitAnchor = captureScrollAnchor(
      split,
      splitRow.top + splitFragment!.top - anchor!.viewportDelta,
    );
    expect(splitAnchor).toMatchObject({
      kind: "text",
      sourceIdentity: identity,
      cellOffset: splitFragment!.start,
    });
    const unifiedAgain = buildDiffDocumentModel(
      input({ files: [changedFile], layout: "unified", viewportWidth: 100 }),
    );
    const finalCell = cellByIdentity(unifiedAgain, identity);
    const finalRow = rowForCell(unifiedAgain, finalCell);
    const finalFragment = finalCell.fragments.find(
      (fragment) =>
        splitAnchor?.kind === "text" &&
        fragment.start <= splitAnchor.cellOffset &&
        splitAnchor.cellOffset < fragment.end,
    );
    expect(resolveScrollAnchor(unifiedAgain, splitAnchor!)).toBe(
      finalRow.top + finalFragment!.top - splitAnchor!.viewportDelta,
    );
  });

  it("uses the exact unified maximum horizontal scroll range", () => {
    const model = buildDiffDocumentModel(
      input({ files: [fileWithChangedLine("x".repeat(30))], wrapLines: false, viewportWidth: 240 }),
    );

    expect(model.files[0]?.contentWidth).toBe(344);
    expect(model.files[0]!.contentWidth - model.viewportWidth).toBe(104);
  });

  it("uses the widest split-column overflow once for the shared file offset", () => {
    const model = buildDiffDocumentModel(
      input({
        files: [fileWithChangedLine("x".repeat(30))],
        layout: "split",
        wrapLines: false,
        viewportWidth: 240,
      }),
    );

    expect(model.files[0]?.contentWidth).toBe(464);
    expect(model.files[0]!.contentWidth - model.viewportWidth).toBe(224);
  });
});

function shapingMeasurer(measure: (text: string) => number): TextMeasurer {
  return {
    measure,
    measureAdvances(graphemes) {
      let prefix = "";
      return graphemes.map((grapheme) => measure((prefix += grapheme)));
    },
  };
}

function ligatureWidth(text: string): number {
  if (text === "fi") return 12;
  if (text === "xfi") return 25;
  let width = 0;
  for (const character of text) width += { x: 10, f: 8, i: 7 }[character] ?? 0;
  return width;
}

function fileWithChangedLine(content: string): ParsedDiffFile {
  const changed = file();
  const hunk = changed.hunks[0]!;
  return {
    ...changed,
    hunks: [
      {
        oldStart: hunk.oldStart,
        oldCount: hunk.oldCount,
        newStart: hunk.newStart,
        newCount: hunk.newCount,
        lines: hunk.lines.map((line) =>
          line.type === "add" ? Object.assign({}, line, { content }) : line,
        ),
      },
    ],
  };
}

function fileWithUnevenChanges(): ParsedDiffFile {
  return {
    path: "src/anchor.ts",
    isNew: false,
    isDeleted: false,
    additions: 3,
    deletions: 2,
    hunks: [
      {
        oldStart: 10,
        oldCount: 2,
        newStart: 20,
        newCount: 3,
        lines: [
          { type: "header", content: "@@ -10,2 +20,3 @@" },
          { type: "remove", content: "removed first" },
          { type: "remove", content: "x" },
          { type: "add", content: "added first" },
          { type: "add", content: "anchored addition has several wrapped fragments" },
          { type: "add", content: "added third" },
        ],
      },
    ],
  };
}

function addedCell(model: ReturnType<typeof buildDiffDocumentModel>) {
  const cell = model.rows
    .filter((row) => row.kind === "line")
    .flatMap((row) => row.cells)
    .find((candidate) => candidate?.type === "add");
  if (!cell) throw new Error("Expected an added cell");
  return cell;
}

function cellByIdentity(
  model: ReturnType<typeof buildDiffDocumentModel>,
  identity: { hunkIndex: number; lineIndex: number; side: "old" | "new" },
) {
  const cell = model.rows
    .filter((row) => row.kind === "line")
    .flatMap((row) => row.cells)
    .find(
      (candidate) =>
        candidate?.sourceIdentity.hunkIndex === identity.hunkIndex &&
        candidate.sourceIdentity.lineIndex === identity.lineIndex &&
        candidate.sourceIdentity.side === identity.side,
    );
  if (!cell) throw new Error("Expected a cell with the source identity");
  return cell;
}

function rowForCell(
  model: ReturnType<typeof buildDiffDocumentModel>,
  cell: ReturnType<typeof cellByIdentity>,
) {
  const row = model.rows.find(
    (candidate) => candidate.kind === "line" && candidate.cells.includes(cell),
  );
  if (!row || row.kind !== "line") throw new Error("Expected the cell row");
  return row;
}

function rowForReviewTarget(model: ReturnType<typeof buildDiffDocumentModel>, key: string) {
  const row = model.rows.find(
    (candidate) =>
      candidate.kind === "line" && candidate.cells.some((cell) => cell?.reviewTarget?.key === key),
  );
  if (!row || row.kind !== "line") throw new Error("Expected the review row");
  return row;
}

function reviewActionsWithEditor(
  target: NonNullable<ReturnType<typeof addedCell>["reviewTarget"]> | null,
): NonNullable<BuildDiffDocumentModelInput["reviewActions"]> {
  return {
    commentsByTarget: new Map(),
    editor: target ? { target, body: "", commentId: null } : null,
    onStartComment() {},
    onCancelEditor() {},
    onSaveEditor() {},
    onEditComment() {},
    onDeleteComment() {},
  };
}
