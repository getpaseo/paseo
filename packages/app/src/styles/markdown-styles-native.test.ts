import { describe, expect, it, vi } from "vitest";
import { createCompactMarkdownStyles, createMarkdownStyles } from "./markdown-styles";
import { darkTheme } from "./theme";

// markdown-styles reads `isWeb` once at module scope, so the native branch needs
// its own file with the mock in place before the import is evaluated.
vi.mock("@/constants/platform", () => ({
  isWeb: false,
  isNative: true,
}));

describe("createMarkdownStyles on native", () => {
  it("keeps inline code the same height as the prose line it sits in", () => {
    // Native paragraphs are wrapping flex rows of sibling <Text> spans, so a
    // taller inline-code item is top-aligned rather than baseline-aligned: the
    // chip background floats above the surrounding text and the wrapped row
    // grows. Matching the prose line height (and dropping the vertical padding)
    // keeps every span in the row the same height.
    const proseLineHeight = Math.round(darkTheme.fontSize.base * 1.4);

    expect(createMarkdownStyles(darkTheme).code_inline).toMatchObject({
      paddingVertical: 0,
      lineHeight: proseLineHeight,
    });
    expect(createCompactMarkdownStyles(darkTheme).code_inline).toMatchObject({
      paddingVertical: 0,
      lineHeight: proseLineHeight,
    });
  });
});
