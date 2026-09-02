import { describe, expect, it } from "vitest";
import { paintWebHeaders, paintWebViewport } from "./paint.web";
import type { DiffCell, DiffDocumentModel, DiffLineRow, DiffPalette, DiffSelection } from "./types";

describe("web diff text shaping", () => {
  it("matches the 30px file-header alignment rails exactly", () => {
    const fills: Array<{ color: string; x: number; y: number; width: number; height: number }> = [];
    const labels: Array<{ text: string; x: number; y: number; color: string; font: string }> = [];
    let fillStyle = "";
    let font = "";
    const context = {
      setTransform() {},
      clearRect() {},
      fillRect(x: number, y: number, width: number, height: number) {
        fills.push({ color: fillStyle, x, y, width, height });
      },
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      translate() {},
      scale() {},
      roundRect() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      measureText(text: string) {
        return {
          width: text.length * 6,
          actualBoundingBoxAscent: 8,
          actualBoundingBoxDescent: 2,
        } as TextMetrics;
      },
      fillText(text: string, x: number, y: number) {
        labels.push({ text, x, y, color: fillStyle, font });
      },
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(value: string | CanvasGradient | CanvasPattern) {
        fillStyle = String(value);
      },
      get font() {
        return font;
      },
      set font(value: string) {
        font = value;
      },
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
    } as unknown as CanvasRenderingContext2D;

    paintWebHeaders({
      context,
      model: {
        ...model,
        files: [
          {
            ...model.files[0]!,
            headerHeight: 30,
            bodyTop: 30,
            bodyHeight: 18,
            bottom: 48,
          },
        ],
        height: 48,
      },
      palette,
      typography: { family: "system-ui", size: 14, statSize: 12 },
      scrollTop: 0,
      viewportWidth: 200,
      viewportHeight: 100,
      devicePixelRatio: 1,
      activePath: null,
    });

    expect(fills.slice(0, 2)).toEqual([
      { color: "header", x: 0, y: 0, width: 200, height: 30 },
      { color: "header-border", x: 0, y: 29, width: 200, height: 1 },
    ]);
    expect(labels).toEqual([
      { text: "+1", x: 142, y: 18, color: "success", font: "12px system-ui" },
      { text: "-0", x: 158, y: 18, color: "danger", font: "12px system-ui" },
      { text: "a.ts", x: 12, y: 18, color: "foreground", font: "14px system-ui" },
      { text: "src", x: 40, y: 18, color: "muted", font: "14px system-ui" },
    ]);
  });

  it("paints syntax colors by clipping the complete measured shaped fragment", () => {
    const paintedText: string[] = [];
    const context = {
      setTransform() {},
      clearRect() {},
      fillRect() {},
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      fillText(text: string) {
        paintedText.push(text);
      },
      fillStyle: "",
      globalAlpha: 1,
      font: "",
      textBaseline: "alphabetic",
    } as unknown as CanvasRenderingContext2D;

    paintWebViewport({
      context,
      model,
      palette,
      typography: { family: "ligature-font", size: 12, lineHeight: 18 },
      measureText: { measure: () => 0 },
      scrollTop: 0,
      viewportWidth: 200,
      viewportHeight: 100,
      horizontalOffsets: new Map(),
      selection: null,
      devicePixelRatio: 1,
    });

    expect(paintedText).toEqual(["fi", "fi"]);
  });

  it("paints review space with the surface color and continues the gutter divider", () => {
    const fills: Array<{ color: string; x: number; y: number; width: number; height: number }> = [];
    let fillStyle = "";
    const context = {
      setTransform() {},
      clearRect() {},
      fillRect(x: number, y: number, width: number, height: number) {
        fills.push({ color: fillStyle, x, y, width, height });
      },
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      fillText() {},
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(value: string | CanvasGradient | CanvasPattern) {
        fillStyle = String(value);
      },
      globalAlpha: 1,
      font: "",
      textBaseline: "alphabetic",
    } as unknown as CanvasRenderingContext2D;

    paintWebViewport({
      context,
      model: modelWithReview,
      palette,
      typography: { family: "monospace", size: 12, lineHeight: 18 },
      measureText: { measure: () => 0 },
      scrollTop: 0,
      viewportWidth: 200,
      viewportHeight: 100,
      horizontalOffsets: new Map(),
      selection: null,
      devicePixelRatio: 1,
    });

    expect(fills).toContainEqual({ color: "surface", x: 0, y: 18, width: 200, height: 40 });
    expect(fills).toContainEqual({ color: "border", x: 20, y: 0, width: 1, height: 58 });
  });

  it("paints every expanded file body's bottom border", () => {
    const fills: Array<{ color: string; x: number; y: number; width: number; height: number }> = [];
    let fillStyle = "";
    const context = {
      setTransform() {},
      clearRect() {},
      fillRect(x: number, y: number, width: number, height: number) {
        fills.push({ color: fillStyle, x, y, width, height });
      },
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      fillText() {},
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(value: string | CanvasGradient | CanvasPattern) {
        fillStyle = String(value);
      },
      globalAlpha: 1,
      font: "",
      textBaseline: "alphabetic",
    } as unknown as CanvasRenderingContext2D;
    const borderedModel: DiffDocumentModel = {
      ...model,
      height: 38,
      files: [
        { ...model.files[0]!, bodyHeight: 19, bottom: 19 },
        {
          ...model.files[0]!,
          file: { ...model.files[0]!.file, path: "src/b.ts" },
          fileIndex: 1,
          path: "src/b.ts",
          top: 19,
          bodyTop: 19,
          bodyHeight: 19,
          bottom: 38,
          rowStart: 1,
          rowEnd: 1,
        },
      ],
    };

    paintWebViewport({
      context,
      model: borderedModel,
      palette,
      typography: { family: "monospace", size: 12, lineHeight: 18 },
      measureText: { measure: () => 0 },
      scrollTop: 0,
      viewportWidth: 200,
      viewportHeight: 100,
      horizontalOffsets: new Map(),
      selection: null,
      devicePixelRatio: 1,
    });

    expect(fills.filter((fill) => fill.color === "border" && fill.x === 0)).toEqual([
      { color: "border", x: 0, y: 18, width: 200, height: 1 },
      { color: "border", x: 0, y: 37, width: 200, height: 1 },
    ]);
  });

  it("clips a horizontally scrolled unified selection to the code viewport", () => {
    const selectionModel = createSelectionModel("unified");
    const paints = paintSelection(selectionModel, selectionForCell(0));

    expect(paints).toEqual([
      {
        x: -22,
        y: 0,
        width: 100,
        height: 18,
        clip: { x: 28, y: 0, width: 172, height: 18 },
      },
    ]);
  });

  it("clips horizontally scrolled split selections to their own code columns", () => {
    const selectionModel = createSelectionModel("split");

    expect(paintSelection(selectionModel, selectionForCell(0))).toEqual([
      {
        x: -22,
        y: 0,
        width: 100,
        height: 18,
        clip: { x: 28, y: 0, width: 72, height: 18 },
      },
    ]);
    expect(paintSelection(selectionModel, selectionForCell(1))).toEqual([
      {
        x: 78,
        y: 0,
        width: 100,
        height: 18,
        clip: { x: 128, y: 0, width: 72, height: 18 },
      },
    ]);
  });
});

interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SelectionPaint extends Rectangle {
  clip: Rectangle | null;
}

function paintSelection(model: DiffDocumentModel, selection: DiffSelection): SelectionPaint[] {
  const paints: SelectionPaint[] = [];
  const clipStack: Array<Rectangle | null> = [];
  let fillStyle = "";
  let pendingRectangle: Rectangle | null = null;
  let currentClip: Rectangle | null = null;
  const context = {
    setTransform() {},
    clearRect() {},
    fillRect(x: number, y: number, width: number, height: number) {
      if (fillStyle === palette.selection) {
        paints.push({ x, y, width, height, clip: currentClip });
      }
    },
    save() {
      clipStack.push(currentClip);
    },
    restore() {
      currentClip = clipStack.pop() ?? null;
    },
    beginPath() {
      pendingRectangle = null;
    },
    rect(x: number, y: number, width: number, height: number) {
      pendingRectangle = { x, y, width, height };
    },
    clip() {
      currentClip = pendingRectangle;
    },
    fillText() {},
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      fillStyle = String(value);
    },
    globalAlpha: 1,
    font: "",
    textBaseline: "alphabetic",
  } as unknown as CanvasRenderingContext2D;

  paintWebViewport({
    context,
    model,
    palette,
    typography: { family: "monospace", size: 12, lineHeight: 18 },
    measureText: { measure: () => 0 },
    scrollTop: 0,
    viewportWidth: 200,
    viewportHeight: 100,
    horizontalOffsets: new Map([["src/selection.ts", 50]]),
    selection,
    devicePixelRatio: 1,
  });
  return paints;
}

function selectionForCell(cellIndex: number): DiffSelection {
  const position = {
    fileIndex: 0,
    rowIndex: 0,
    cellIndex,
    side: cellIndex === 0 ? ("old" as const) : ("new" as const),
  };
  return {
    anchor: { ...position, sourceOffset: 0 },
    focus: { ...position, sourceOffset: 10 },
  };
}

function createSelectionModel(layout: "unified" | "split"): DiffDocumentModel {
  const cells: DiffLineRow["cells"] =
    layout === "unified" ? [selectionCell("new")] : [selectionCell("old"), selectionCell("new")];
  return {
    files: [
      {
        file: {
          path: "src/selection.ts",
          isNew: false,
          isDeleted: false,
          additions: 1,
          deletions: 1,
          hunks: [],
        },
        fileIndex: 0,
        path: "src/selection.ts",
        top: 0,
        headerHeight: 0,
        bodyTop: 0,
        bodyHeight: 18,
        bottom: 18,
        gutterWidth: 20,
        contentWidth: 300,
        rowStart: 0,
        rowEnd: 1,
        isCollapsed: false,
      },
    ],
    rows: [
      {
        kind: "line",
        index: 0,
        fileIndex: 0,
        path: "src/selection.ts",
        top: 0,
        height: 18,
        reviewHeight: 0,
        cells,
      },
    ],
    height: 18,
    lineHeight: 18,
    layout,
    wrapLines: false,
    viewportWidth: 200,
    reviewGeometryKey: "",
  };
}

function selectionCell(side: "old" | "new"): DiffCell {
  return {
    type: side === "old" ? "remove" : "add",
    content: "abcdefghij",
    lineNumber: 1,
    tokens: [],
    fragments: [
      {
        start: 0,
        end: 10,
        text: "abcdefghij",
        width: 100,
        top: 0,
        baseline: 14,
        graphemes: Array.from("abcdefghij", (text, index) => ({
          start: index,
          end: index + 1,
          text,
          width: 10,
        })),
      },
    ],
    reviewTarget: null,
    sourceIdentity: { hunkIndex: 0, lineIndex: 1, side },
  };
}

const palette: DiffPalette = {
  surface: "surface",
  headerSurface: "header",
  border: "border",
  foreground: "foreground",
  foregroundMuted: "muted",
  addition: "green",
  deletion: "red",
  additionBackground: "green-bg",
  deletionBackground: "red-bg",
  emptyBackground: "empty",
  selection: "selection",
  headerActiveSurface: "active-header",
  headerBorder: "header-border",
  statusSuccess: "success",
  statusDanger: "danger",
  statusWarning: "warning",
  syntax: { first: "red", second: "blue" },
};

const model: DiffDocumentModel = {
  files: [
    {
      file: {
        path: "src/a.ts",
        isNew: false,
        isDeleted: false,
        additions: 1,
        deletions: 0,
        hunks: [],
      },
      fileIndex: 0,
      path: "src/a.ts",
      top: 0,
      headerHeight: 0,
      bodyTop: 0,
      bodyHeight: 18,
      bottom: 18,
      gutterWidth: 20,
      contentWidth: 200,
      rowStart: 0,
      rowEnd: 1,
      isCollapsed: false,
    },
  ],
  rows: [
    {
      kind: "line",
      index: 0,
      fileIndex: 0,
      path: "src/a.ts",
      top: 0,
      height: 18,
      reviewHeight: 0,
      cells: [
        {
          type: "add",
          content: "fi",
          lineNumber: null,
          tokens: [
            { start: 0, end: 1, color: "red" },
            { start: 1, end: 2, color: "blue" },
          ],
          fragments: [
            {
              start: 0,
              end: 2,
              text: "fi",
              width: 15,
              top: 0,
              baseline: 14,
              graphemes: [
                { start: 0, end: 1, text: "f", width: 10 },
                { start: 1, end: 2, text: "i", width: 5 },
              ],
            },
          ],
          reviewTarget: null,
          sourceIdentity: { hunkIndex: 0, lineIndex: 1, side: "new" },
        },
      ],
    },
  ],
  height: 18,
  lineHeight: 18,
  layout: "unified",
  wrapLines: false,
  viewportWidth: 200,
  reviewGeometryKey: "",
};

const modelWithReview: DiffDocumentModel = {
  ...model,
  files: [{ ...model.files[0]!, bodyHeight: 58, bottom: 58 }],
  rows: [
    {
      ...(model.rows[0] as DiffLineRow),
      height: 58,
      reviewHeight: 40,
    },
  ],
  height: 58,
};
