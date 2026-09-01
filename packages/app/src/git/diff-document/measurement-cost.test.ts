import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { buildDiffDocumentModel } from "./model";
import type { BuildDiffDocumentModelInput, TextMeasurer } from "./types";

/**
 * A text backend that can only measure a whole string costs O(string length)
 * per call, so measuring cumulative advances by re-shaping a growing prefix
 * shapes n^2/2 characters for one line of n characters. That froze the renderer
 * for ~10s on a 42-line CHANGELOG.md diff and for over 15 minutes on a diff
 * containing a single 1.2M-character line.
 *
 * Cost is counted in *shaped characters* rather than calls, because that is the
 * quantity that maps to renderer CPU time. The budgets below are the linear
 * contract of the shared advance measurement in `text-measurement.ts`: work
 * stays proportional to the text, with a constant bounded by the shaped-run cap.
 */
const SHAPED_RUN_LIMIT = 64;

function countingMeasurer(): { stats: { shapedCharacters: number }; measurer: TextMeasurer } {
  const stats = { shapedCharacters: 0 };
  return {
    stats,
    measurer: {
      measure(text) {
        stats.shapedCharacters += text.length;
        return text.length * 10;
      },
    },
  };
}

/** Ligature-bearing source, so measurement takes the shaping path rather than the cache. */
function codeLine(length: number): string {
  const unit = "const value = (a, b) => a === b ? 1 : 0; ";
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

function diffFile(lines: readonly string[]): ParsedDiffFile {
  return {
    path: "src/a.ts",
    isNew: false,
    isDeleted: false,
    additions: lines.length,
    deletions: 0,
    hunks: [
      {
        oldStart: 1,
        oldCount: 0,
        newStart: 1,
        newCount: lines.length,
        lines: lines.map((content) => ({ type: "add" as const, content })),
      },
    ],
  };
}

function shapedCharactersFor(options: { lineCount: number; lineLength: number }): number {
  const { stats, measurer } = countingMeasurer();
  const line = codeLine(options.lineLength);
  const input: BuildDiffDocumentModelInput = {
    files: [diffFile(Array.from({ length: options.lineCount }, () => line))],
    collapsedFilePaths: new Set(),
    layout: "unified",
    wrapLines: false,
    viewportWidth: 1200,
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
  };
  buildDiffDocumentModel(input);
  return stats.shapedCharacters;
}

describe("diff document measurement cost", () => {
  it("shapes a bounded number of characters per character of text", () => {
    // The shape of the CHANGELOG.md working diff that froze the renderer: 42
    // lines, longest 597 characters.
    const lineCount = 42;
    const lineLength = 597;
    const shaped = shapedCharactersFor({ lineCount, lineLength });
    expect(shaped).toBeLessThanOrEqual(lineCount * lineLength * SHAPED_RUN_LIMIT);
  });

  it("does not grow super-linearly with line length", () => {
    const short = shapedCharactersFor({ lineCount: 1, lineLength: 50 });
    const long = shapedCharactersFor({ lineCount: 1, lineLength: 800 });
    // 16x the characters must not cost more than ~16x the shaping work.
    expect(long / short).toBeLessThan(32);
  });

  it("grows no faster than linearly with line count", () => {
    const ten = shapedCharactersFor({ lineCount: 10, lineLength: 100 });
    const hundred = shapedCharactersFor({ lineCount: 100, lineLength: 100 });
    expect(hundred).toBeLessThanOrEqual(ten * 10);
  });
});
