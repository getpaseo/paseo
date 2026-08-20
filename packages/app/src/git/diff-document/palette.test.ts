import { describe, expect, it } from "vitest";
import { darkTheme, lightTheme } from "@/styles/theme";
import { hexColorWithAlpha } from "@/utils/color";
import { codeLineNumberTone, codeTextColor, createDiffPalette, retainDiffPalette } from "./palette";
import type { DiffCell, DiffPalette } from "./types";

describe("diff text color", () => {
  it.each(["add", "remove", "context"] as const)(
    "uses normal code foreground for an untokenized %s line",
    (type) => {
      expect(codeTextColor(cell(type), palette)).toBe("foreground");
    },
  );

  it.each([
    ["add", "addition"],
    ["remove", "deletion"],
    ["context", "foregroundMuted"],
  ] as const)("uses the %s gutter tone for native and web line numbers", (type, tone) => {
    expect(codeLineNumberTone(cell(type))).toBe(tone);
  });
});

describe("diff palette retention", () => {
  it("retains the previous value when a theme wrapper recreates equal colors", () => {
    const recreated = { ...palette, syntax: { keyword: "purple" } };
    const previous = { ...recreated, syntax: { keyword: "purple" } };

    expect(retainDiffPalette(previous, recreated)).toBe(previous);
  });

  it("accepts a real color change", () => {
    const changed = { ...palette, foreground: "new-foreground" };

    expect(retainDiffPalette(palette, changed)).toBe(changed);
  });
});

describe.each([lightTheme, darkTheme])("semantic diff colors", (theme) => {
  it("uses the app status palette for gutter text and derived row tints", () => {
    const created = createDiffPalette(theme);

    expect(created.addition).toBe(theme.colors.statusSuccess);
    expect(created.deletion).toBe(theme.colors.statusDanger);
    expect(created.additionBackground).toBe(hexColorWithAlpha(theme.colors.statusSuccess, 0.15));
    expect(created.deletionBackground).toBe(hexColorWithAlpha(theme.colors.statusDanger, 0.1));
  });
});

const palette: DiffPalette = {
  surface: "surface",
  headerSurface: "header",
  border: "border",
  foreground: "foreground",
  foregroundMuted: "muted",
  addition: "green",
  deletion: "red",
  additionBackground: "green-bg",
  deletionBackground: "red-bg",
  emptyBackground: "empty",
  selection: "selection",
  syntax: {},
};

function cell(type: DiffCell["type"]): DiffCell {
  return {
    type,
    content: "code",
    lineNumber: 1,
    tokens: [],
    fragments: [],
    reviewTarget: null,
    sourceIdentity: { hunkIndex: 0, lineIndex: 1, side: "new" },
  };
}
