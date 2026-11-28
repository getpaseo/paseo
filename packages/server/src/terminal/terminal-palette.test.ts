import { describe, expect, it } from "vitest";
import {
  formatColorSchemeReport,
  resolveTerminalPalette,
  terminalPalettesEqual,
} from "./terminal-palette.js";

describe("terminal palette", () => {
  it("falls back to dark defaults when defaultColors is omitted", () => {
    const palette = resolveTerminalPalette();
    expect(palette.oscResponses.get(10)).toBe("rgb:e6e6/e6e6/e6e6");
    expect(palette.oscResponses.get(11)).toBe("rgb:0b0b/0b0b/0b0b");
    expect(palette.oscResponses.get(12)).toBe("rgb:e6e6/e6e6/e6e6");
    expect(palette.colorScheme).toBe("dark");
    expect(palette.colorFgBg).toBe("15;0");
  });

  it("resolves light theme colors, 16-bit X11 rgb replies, and light COLORFGBG", () => {
    const palette = resolveTerminalPalette({
      foreground: "#1a1a1e",
      background: "#ffffff",
      cursor: "#1a1a1e",
    });
    expect(palette.oscResponses.get(10)).toBe("rgb:1a1a/1a1a/1e1e");
    expect(palette.oscResponses.get(11)).toBe("rgb:ffff/ffff/ffff");
    expect(palette.oscResponses.get(12)).toBe("rgb:1a1a/1a1a/1e1e");
    expect(palette.colorScheme).toBe("light");
    expect(palette.colorFgBg).toBe("0;15");
  });

  it("defaults cursor to foreground when cursor is omitted", () => {
    const palette = resolveTerminalPalette({
      foreground: "#112233",
      background: "#fafafa",
    });
    expect(palette.oscResponses.get(12)).toBe("rgb:1111/2222/3333");
    expect(palette.colorScheme).toBe("light");
    expect(palette.colorFgBg).toBe("0;15");
  });

  it("composites translucent hex colors over the displayed background", () => {
    const palette = resolveTerminalPalette({
      foreground: "#33669980",
      background: "#112233cc",
      cursor: "#abcdef40",
    });
    expect(palette.oscResponses.get(10)).toBe("rgb:2222/4242/6262");
    expect(palette.oscResponses.get(11)).toBe("rgb:1010/1d1d/2b2b");
    expect(palette.oscResponses.get(12)).toBe("rgb:3737/4949/5c5c");
    expect(palette.colorScheme).toBe("dark");
    expect(palette.colorFgBg).toBe("15;0");
  });

  it("expands 3-digit and 4-digit hex shorthands", () => {
    const palette = resolveTerminalPalette({
      foreground: "#123",
      background: "#fff",
      cursor: "#f008",
    });
    expect(palette.oscResponses.get(10)).toBe("rgb:1111/2222/3333");
    expect(palette.oscResponses.get(11)).toBe("rgb:ffff/ffff/ffff");
    expect(palette.oscResponses.get(12)).toBe("rgb:ffff/7777/7777");
    expect(palette.colorScheme).toBe("light");
  });

  it("formats DSR 997 color-scheme reports for dark and light modes", () => {
    expect(formatColorSchemeReport("dark")).toBe("\x1b[?997;1n");
    expect(formatColorSchemeReport("light")).toBe("\x1b[?997;2n");
  });

  it("compares resolved palettes by displayed foreground, background, and cursor", () => {
    const lightA = resolveTerminalPalette({ foreground: "#1a1a1e", background: "#fff" });
    const lightB = resolveTerminalPalette({
      foreground: "#1A1A1E",
      background: "#ffffff",
      cursor: "#1a1a1e",
    });
    const dark = resolveTerminalPalette({ foreground: "#fafafa", background: "#181b1a" });

    expect(terminalPalettesEqual(lightA, lightB)).toBe(true);
    expect(terminalPalettesEqual(lightA, dark)).toBe(false);
  });
});
