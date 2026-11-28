import { lightHighlightColors, type HighlightStyle } from "@getpaseo/highlight";
import { describe, expect, it } from "vitest";
import { appearanceStyleBoundaryKey } from "@/components/appearance-style-boundary";
import { lightTheme } from "./theme";
import { syntaxTokenStyleFor, syntaxTokenStyles } from "./syntax-token-styles";

describe("syntaxTokenStyleFor", () => {
  it("maps diffAddition, diffDeletion, and meta to distinct token colors", () => {
    expect(syntaxTokenStyleFor("diffAddition")).toEqual({
      color: lightHighlightColors.diffAddition,
    });
    expect(syntaxTokenStyleFor("diffDeletion")).toEqual({
      color: lightHighlightColors.diffDeletion,
    });
    expect(syntaxTokenStyleFor("meta")).toEqual({ color: lightHighlightColors.meta });
  });

  it("resolves every HighlightStyle without falling back to base", () => {
    const styles: HighlightStyle[] = [
      "keyword",
      "comment",
      "string",
      "number",
      "literal",
      "function",
      "definition",
      "class",
      "type",
      "tag",
      "attribute",
      "property",
      "variable",
      "operator",
      "punctuation",
      "regexp",
      "escape",
      "meta",
      "heading",
      "link",
      "diffAddition",
      "diffDeletion",
    ];
    for (const style of styles) {
      expect(syntaxTokenStyleFor(style)).toBe(syntaxTokenStyles[style]);
    }
    expect(syntaxTokenStyleFor(null)).toBe(syntaxTokenStyles.base);
    expect(syntaxTokenStyleFor("unknown")).toBe(syntaxTokenStyles.base);
  });

  it("tracks diffAddition and diffDeletion in appearanceStyleBoundaryKey", () => {
    const changedAddition = {
      ...lightTheme,
      colors: {
        ...lightTheme.colors,
        syntax: { ...lightTheme.colors.syntax, diffAddition: "#00ff00" },
      },
    };
    const changedDeletion = {
      ...lightTheme,
      colors: {
        ...lightTheme.colors,
        syntax: { ...lightTheme.colors.syntax, diffDeletion: "#ff0000" },
      },
    };

    expect(appearanceStyleBoundaryKey(changedAddition)).not.toBe(
      appearanceStyleBoundaryKey(lightTheme),
    );
    expect(appearanceStyleBoundaryKey(changedDeletion)).not.toBe(
      appearanceStyleBoundaryKey(lightTheme),
    );
  });
});
