import { describe, it, expect } from "vitest";
import { darkHighlightColors, lightHighlightColors } from "../colors.js";
import type { HighlightStyle } from "../types.js";

const allStyles: HighlightStyle[] = [
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

describe("darkHighlightColors", () => {
  it("covers all HighlightStyle values", () => {
    for (const style of allStyles) {
      expect(darkHighlightColors[style]).toBeDefined();
      expect(typeof darkHighlightColors[style]).toBe("string");
    }
  });

  it("has valid hex color values", () => {
    for (const style of allStyles) {
      expect(darkHighlightColors[style]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

describe("lightHighlightColors", () => {
  it("covers all HighlightStyle values", () => {
    for (const style of allStyles) {
      expect(lightHighlightColors[style]).toBeDefined();
      expect(typeof lightHighlightColors[style]).toBe("string");
    }
  });

  it("has valid hex color values", () => {
    for (const style of allStyles) {
      expect(lightHighlightColors[style]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

describe("color map completeness", () => {
  it("dark and light maps have the same keys", () => {
    const darkKeys = Object.keys(darkHighlightColors).sort();
    const lightKeys = Object.keys(lightHighlightColors).sort();

    expect(darkKeys).toEqual(lightKeys);
  });
});
