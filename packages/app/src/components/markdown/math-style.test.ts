import { describe, expect, it } from "vitest";
import { createMarkdownStyles } from "./styles";
import { darkTheme, lightTheme } from "@/styles/theme";

describe("math styles follow the theme", () => {
  for (const [name, theme] of [
    ["dark", darkTheme],
    ["light", lightTheme],
  ] as const) {
    it(`keeps ${name} math on the theme foreground without a card`, () => {
      const { markdownStyle } = createMarkdownStyles(theme, { blockGap: 8 });
      expect(markdownStyle.inlineMath?.color).toBe(theme.colors.foreground);
      expect(markdownStyle.math?.color).toBe(theme.colors.foreground);
      // The library default is a light card; a filled background looks wrong on dark themes.
      expect(markdownStyle.math?.backgroundColor).toBe("transparent");
    });
  }
  it("leaves vertical padding on display math so the scroll container does not paint a bar", () => {
    const { markdownStyle } = createMarkdownStyles(darkTheme, { blockGap: 8 });
    expect(markdownStyle.math?.padding).toBeGreaterThanOrEqual(6);
  });
});
