import { describe, expect, it } from "vitest";
import {
  createFilePaneFindTokenSegments,
  createFilePaneLineFindHighlightMap,
  createFilePaneTextRenderData,
  findFilePaneTextMatches,
} from "@/components/file-pane-text-render-data";
import type { FilePaneTextLineRenderData } from "@/components/file-pane-text-render-data";

function tokenText(line: FilePaneTextLineRenderData): string {
  return line.tokens.map(({ text }) => text).join("");
}

describe("createFilePaneTextRenderData", () => {
  it("keeps code render lines in source order and reconstructs searchable text from tokens", () => {
    const renderData = createFilePaneTextRenderData(
      "const answer = 42;\nconsole.log(answer);",
      "src/answer.ts",
    );

    expect(renderData.lines.map((line) => line.lineNumber)).toEqual([1, 2]);
    expect(renderData.lines.map((line) => line.text)).toEqual([
      "const answer = 42;",
      "console.log(answer);",
    ]);
    expect(renderData.searchableText).toBe("const answer = 42;\nconsole.log(answer);");
    const tokenTexts = renderData.lines.map(tokenText);
    expect(tokenTexts).toEqual(renderData.lines.map((line) => line.text));
  });

  it("preserves blank text lines for navigation and scrolling targets", () => {
    const renderData = createFilePaneTextRenderData("alpha\n\nbeta", "notes.txt");

    expect(
      renderData.lines.map((line) => ({ lineNumber: line.lineNumber, text: line.text })),
    ).toEqual([
      { lineNumber: 1, text: "alpha" },
      { lineNumber: 2, text: "" },
      { lineNumber: 3, text: "beta" },
    ]);
    expect(renderData.searchableText).toBe("alpha\n\nbeta");
  });
});

describe("findFilePaneTextMatches", () => {
  it("indexes loaded text case-insensitively in source order", () => {
    const renderData = createFilePaneTextRenderData(
      "Alpha beta\nBETA gamma\nalphabet",
      "notes.txt",
    );

    const matches = findFilePaneTextMatches(renderData, "beta");

    expect(
      matches.map((match) => ({
        index: match.index,
        lineSpans: match.lineSpans,
      })),
    ).toEqual([
      {
        index: 0,
        lineSpans: [{ lineNumber: 1, startColumn: 6, endColumn: 10 }],
      },
      {
        index: 1,
        lineSpans: [{ lineNumber: 2, startColumn: 0, endColumn: 4 }],
      },
    ]);
  });

  it("maps pasted multi-line queries back to per-line spans", () => {
    const renderData = createFilePaneTextRenderData("alpha\nbeta", "notes.txt");

    const matches = findFilePaneTextMatches(renderData, "ha\nbe");

    expect(matches).toHaveLength(1);
    expect(matches[0]?.lineSpans).toEqual([
      { lineNumber: 1, startColumn: 3, endColumn: 5 },
      { lineNumber: 2, startColumn: 0, endColumn: 2 },
    ]);
  });
});

describe("createFilePaneFindTokenSegments", () => {
  it("splits immutable token render data around match spans and marks the current match", () => {
    const line: FilePaneTextLineRenderData = {
      lineNumber: 1,
      text: "const answer",
      tokens: [
        { text: "const", style: "keyword" },
        { text: " answer", style: null },
      ],
    };
    const highlights = createFilePaneLineFindHighlightMap(
      [
        {
          index: 0,
          startOffset: 2,
          endOffset: 8,
          lineSpans: [{ lineNumber: 1, startColumn: 2, endColumn: 8 }],
        },
      ],
      0,
    );

    const segments = createFilePaneFindTokenSegments(line, highlights.get(1) ?? []);

    expect(segments).toEqual([
      { text: "co", style: "keyword", isFindMatch: false, isCurrentFindMatch: false },
      { text: "nst", style: "keyword", isFindMatch: true, isCurrentFindMatch: true },
      { text: " an", style: null, isFindMatch: true, isCurrentFindMatch: true },
      { text: "swer", style: null, isFindMatch: false, isCurrentFindMatch: false },
    ]);
    expect(line.tokens).toEqual([
      { text: "const", style: "keyword" },
      { text: " answer", style: null },
    ]);
  });
});
