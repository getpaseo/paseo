import { describe, expect, it } from "vitest";

import {
  formatDiffContentText,
  formatDiffGutterText,
  hasVisibleDiffTokens,
} from "./diff-rendering";

describe("diff-rendering", () => {
  it("keeps header gutters tall even when they do not show a line number", () => {
    // Must be a non-collapsing whitespace: the gutter <Text> uses
    // numberOfLines={1}, which on web wraps in display:-webkit-box;
    // overflow:hidden. A plain ASCII space collapses to zero height
    // there and shifts every line number up by one row.
    expect(formatDiffGutterText(null)).toBe("\u00A0");
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
