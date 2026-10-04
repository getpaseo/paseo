import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  buildMinimapChangeRanges,
  buildMinimapLines,
  minimapScale,
  minimapSlider,
  MINIMAP_MAX_PIXELS_PER_LINE,
  scrollTopForMinimapPointer,
} from "./minimap-geometry";
import { buildDiffDocumentModel, FILE_HEADER_HEIGHT } from "./model";
import type { BuildDiffDocumentModelInput } from "./types";

const LINE_HEIGHT = 18;

function wholeFile(): ParsedDiffFile {
  return {
    path: "src/a.ts",
    isNew: false,
    isDeleted: false,
    additions: 2,
    deletions: 1,
    hunks: [
      {
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 4,
        lines: [
          { type: "context", content: "function a() {" },
          { type: "remove", content: "\treturn 1;" },
          { type: "add", content: "  return 2;" },
          { type: "add", content: "  // extra" },
          { type: "context", content: "}" },
        ],
      },
    ],
  };
}

function model(layout: "unified" | "split") {
  const input: BuildDiffDocumentModelInput = {
    files: [wholeFile()],
    collapsedFilePaths: new Set(),
    layout,
    wrapLines: false,
    viewportWidth: 800,
    typography: { family: "monospace", size: 12, lineHeight: LINE_HEIGHT },
    measureText: { measure: (text) => text.length * 7 },
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
  };
  return buildDiffDocumentModel(input);
}

describe("buildMinimapLines", () => {
  it("maps unified rows to change kinds and code shapes", () => {
    const lines = buildMinimapLines(model("unified"));

    expect(lines.map((line) => line.change)).toEqual([null, "remove", "add", "add", null]);
    expect(lines[0]).toMatchObject({ top: FILE_HEADER_HEIGHT, indent: 0, length: 14 });
    expect(lines[1]).toMatchObject({ indent: 4, length: 9 });
    expect(lines[2]).toMatchObject({ top: FILE_HEADER_HEIGHT + LINE_HEIGHT * 2, indent: 2 });
  });

  it("marks a split row pairing a removal with an addition as modified", () => {
    const lines = buildMinimapLines(model("split"));

    expect(lines.map((line) => line.change)).toEqual([null, "modify", "add", null]);
  });
});

describe("buildMinimapChangeRanges", () => {
  it("merges adjacent lines of the same change", () => {
    const ranges = buildMinimapChangeRanges(buildMinimapLines(model("unified")));

    expect(ranges).toEqual([
      {
        top: FILE_HEADER_HEIGHT + LINE_HEIGHT,
        bottom: FILE_HEADER_HEIGHT + LINE_HEIGHT * 2,
        change: "remove",
      },
      {
        top: FILE_HEADER_HEIGHT + LINE_HEIGHT * 2,
        bottom: FILE_HEADER_HEIGHT + LINE_HEIGHT * 4,
        change: "add",
      },
    ]);
  });
});

describe("minimap geometry", () => {
  it("fits a long document and caps a short one", () => {
    expect(minimapScale({ documentHeight: 10_000, minimapHeight: 500, lineHeight: 18 })).toBe(0.05);
    expect(minimapScale({ documentHeight: 100, minimapHeight: 500, lineHeight: 18 })).toBe(
      MINIMAP_MAX_PIXELS_PER_LINE / 18,
    );
    expect(minimapScale({ documentHeight: 0, minimapHeight: 500, lineHeight: 18 })).toBe(0);
  });

  it("sizes the slider to the viewport", () => {
    expect(minimapSlider({ scale: 0.05, scrollTop: 2000, viewportHeight: 600 })).toEqual({
      top: 100,
      height: 30,
    });
  });

  it("converts a pointer position into a clamped scroll offset", () => {
    const base = { scale: 0.05, documentHeight: 10_000, viewportHeight: 600 };
    expect(scrollTopForMinimapPointer({ ...base, y: 115, grabOffset: 15 })).toBe(2000);
    expect(scrollTopForMinimapPointer({ ...base, y: 0, grabOffset: 15 })).toBe(0);
    expect(scrollTopForMinimapPointer({ ...base, y: 1000, grabOffset: 0 })).toBe(9400);
  });
});
