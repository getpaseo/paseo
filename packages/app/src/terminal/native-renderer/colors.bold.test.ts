import { describe, expect, it } from "vitest";
import { createTerminalCellStyleResolver, DEFAULT_TERMINAL_THEME } from "./colors";
import type { TerminalCell } from "@getpaseo/protocol/messages";

function boldCell(): TerminalCell {
  return { char: "x", bold: true };
}

describe("native terminal bold text", () => {
  it("renders bold cells at weight 700 by default", () => {
    const resolver = createTerminalCellStyleResolver(DEFAULT_TERMINAL_THEME);
    expect(resolver.resolve(boldCell()).style.fontWeight).toBe("700");
  });

  it("drops the weight when bold text is off", () => {
    const resolver = createTerminalCellStyleResolver(DEFAULT_TERMINAL_THEME, { boldText: false });
    expect(resolver.resolve(boldCell()).style.fontWeight).toBeUndefined();
  });

  // Colors come from the SGR sequence, not the weight, so shell syntax
  // highlighting has to survive turning bold off.
  it("keeps the cell color when bold text is off", () => {
    const bold = createTerminalCellStyleResolver(DEFAULT_TERMINAL_THEME);
    const plain = createTerminalCellStyleResolver(DEFAULT_TERMINAL_THEME, { boldText: false });
    expect(plain.resolve(boldCell()).foregroundColor).toBe(
      bold.resolve(boldCell()).foregroundColor,
    );
  });

  // themeKey drives downstream memoization; if it ignored boldText the grid would
  // keep painting cached bold styles after the toggle flipped.
  it("changes themeKey so cached styles are invalidated", () => {
    const bold = createTerminalCellStyleResolver(DEFAULT_TERMINAL_THEME);
    const plain = createTerminalCellStyleResolver(DEFAULT_TERMINAL_THEME, { boldText: false });
    expect(plain.themeKey).not.toBe(bold.themeKey);
  });
});
