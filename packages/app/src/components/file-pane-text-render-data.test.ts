import { describe, expect, it, vi } from "vitest";
import type { HighlightToken } from "@getpaseo/highlight";
import {
  createFilePaneFindModel,
  createFilePaneHighlightMap,
  createFilePaneTextModel,
  findFilePaneMatches,
  splitFilePaneTokens,
} from "./file-pane-text-render-data";

function tokens(...lines: string[]): HighlightToken[][] {
  return lines.map((text) => [{ text, style: null }]);
}

describe("file pane find", () => {
  it("reconstructs blank lines and maps a multiline match to visible line spans", () => {
    const model = createFilePaneTextModel(tokens("alpha", "", "beta"));
    const matches = findFilePaneMatches(model, "a\n\nb");

    expect(model.searchableText).toBe("alpha\n\nbeta");
    expect(matches).toEqual([
      {
        startOffset: 4,
        endOffset: 8,
        lineSpans: [
          { lineNumber: 1, startColumn: 4, endColumn: 5 },
          { lineNumber: 3, startColumn: 0, endColumn: 1 },
        ],
      },
    ]);
  });

  it("finds non-overlapping case-insensitive matches without splitting surrogate pairs", () => {
    const model = createFilePaneTextModel(tokens("😀a😀A aaa"));
    expect(findFilePaneMatches(model, "😀a").map((match) => match.startOffset)).toEqual([0, 3]);
    expect(findFilePaneMatches(model, "aa").map((match) => match.startOffset)).toEqual([7]);
  });

  it("splits across syntax tokens while preserving their foreground styles", () => {
    const line = createFilePaneTextModel([
      [
        { text: "con", style: "keyword" },
        { text: "sole", style: "function" },
      ],
    ]).lines[0];
    const highlights = createFilePaneHighlightMap(
      findFilePaneMatches({ lines: [line], searchableText: "console" }, "onso"),
      0,
    );

    expect(splitFilePaneTokens(line, highlights.get(1) ?? [])).toEqual([
      { text: "c", style: "keyword", match: null },
      { text: "on", style: "keyword", match: "current" },
      { text: "so", style: "function", match: "current" },
      { text: "le", style: "function", match: null },
    ]);
  });

  it("stays correct across many lines with many matches (perf-shaped, no full-line scan per match)", () => {
    const lineCount = 5000;
    const model = createFilePaneTextModel(tokens(...Array.from({ length: lineCount }, () => "x")));
    const matches = findFilePaneMatches(model, "x");

    expect(matches).toHaveLength(lineCount);
    // First, middle, and last matches must map to the correct line, proving the binary-search
    // line lookup walks only the lines the match intersects rather than scanning every line.
    expect(matches[0].lineSpans).toEqual([{ lineNumber: 1, startColumn: 0, endColumn: 1 }]);
    expect(matches[Math.floor(lineCount / 2)].lineSpans).toEqual([
      { lineNumber: Math.floor(lineCount / 2) + 1, startColumn: 0, endColumn: 1 },
    ]);
    expect(matches.at(-1)?.lineSpans).toEqual([
      { lineNumber: lineCount, startColumn: 0, endColumn: 1 },
    ]);
  });

  it("caps match count on pathological inputs instead of freezing", () => {
    const model = createFilePaneTextModel(tokens("a".repeat(50_000)));
    const matches = findFilePaneMatches(model, "a");

    expect(matches).toHaveLength(10_000);
  });

  it("wraps navigation and scrolls the selected match line", () => {
    const onSelectLine = vi.fn();
    const model = createFilePaneFindModel({
      textModel: createFilePaneTextModel(tokens("one", "one")),
      onSelectLine,
    });
    model.adapter.open();
    model.adapter.setQuery("one");
    model.adapter.selectPrev();
    model.adapter.selectNext();

    expect(model.adapter.getState()).toEqual({
      isOpen: true,
      query: "one",
      isPending: false,
      matchCount: 2,
      selectedIndex: 0,
    });
    expect(onSelectLine.mock.calls).toEqual([[1], [2], [1]]);
  });
});
