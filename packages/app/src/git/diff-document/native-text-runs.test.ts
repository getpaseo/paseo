import { describe, expect, it } from "vitest";
import { nativeTextRuns } from "./native-text-runs";
import type { DiffCell, DiffFragment } from "./types";

describe("native diff text runs", () => {
  it("positions adjacent token text without redrawing through clipped color bands", () => {
    const fragment: DiffFragment = {
      start: 0,
      end: 6,
      text: "import",
      width: 42,
      top: 0,
      baseline: 14,
      graphemes: [..."import"].map((text, index) => ({
        start: index,
        end: index + 1,
        text,
        width: 7,
      })),
    };
    const cell: DiffCell = {
      type: "context",
      content: "import",
      lineNumber: 1,
      tokens: [
        { start: 0, end: 2, color: "purple" },
        { start: 2, end: 6, color: "blue" },
      ],
      fragments: [fragment],
      reviewTarget: null,
      sourceIdentity: { hunkIndex: 0, lineIndex: 1, side: "new" },
    };

    expect(nativeTextRuns(cell, fragment)).toEqual([
      { color: "purple", left: 0, text: "im" },
      { color: "blue", left: 14, text: "port" },
    ]);
  });
});
