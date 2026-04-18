import { describe, expect, it } from "vitest";

import {
  formatDiffContentText,
  formatDiffGutterText,
  hasVisibleDiffTokens,
} from "./diff-rendering";

describe("diff-rendering", () => {
  it("keeps header gutters tall even when they do not show a line number", () => {
    expect(formatDiffGutterText(null)).toBe(" ");
    expect(formatDiffGutterText(82)).toBe("82");
  });

  it("keeps empty split cells tall even when they have no visible content", () => {
    expect(formatDiffContentText(undefined)).toBe(" ");
    expect(formatDiffContentText("")).toBe(" ");
    expect(formatDiffContentText("const value = 1;")).toBe("const value = 1;");
  });

  it("treats empty highlighted token rows as blank lines instead of visible content", () => {
    expect(hasVisibleDiffTokens(undefined)).toBe(false);
    expect(hasVisibleDiffTokens([])).toBe(false);
    expect(hasVisibleDiffTokens([{ text: "" }])).toBe(false);
    expect(hasVisibleDiffTokens([{ text: "const value = 1;" }])).toBe(true);
  });
});
