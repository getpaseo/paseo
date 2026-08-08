import { describe, expect, it } from "vitest";
import { lightCatppuccinLatteTheme } from "./theme";

describe("Catppuccin Latte terminal colors", () => {
  it("uses readable ANSI white values on its light background", () => {
    expect(lightCatppuccinLatteTheme.colors.terminal.white).toBe("#6c6f85");
    expect(lightCatppuccinLatteTheme.colors.terminal.brightWhite).toBe("#4c4f69");
  });
});
