import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_LINE_HEIGHT,
  MAX_TERMINAL_LINE_HEIGHT,
  MIN_TERMINAL_LINE_HEIGHT,
  resolveTerminalFontFamily,
  resolveTerminalFontWeightBold,
  resolveTerminalLineHeight,
} from "./terminal-font";

describe("resolveTerminalFontFamily", () => {
  // The blank case is the whole point of the setting: it is what routes the
  // terminal to the Nerd Font stack instead of a code font with no prompt glyphs.
  it("falls back to the Nerd Font stack when unset, empty, or whitespace", () => {
    expect(resolveTerminalFontFamily(undefined)).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(resolveTerminalFontFamily("")).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(resolveTerminalFontFamily("   ")).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
  });

  it("keeps the Nerd Font families ahead of the system fallbacks", () => {
    const families = DEFAULT_TERMINAL_FONT_FAMILY.split(", ");
    expect(families.indexOf("JetBrainsMono Nerd Font")).toBeLessThan(families.indexOf("Menlo"));
  });

  // An unresolvable name with no fallback lands on the browser's default
  // proportional font, which breaks the fixed grid outright — so every explicit
  // value gets a generic monospace backstop.
  it("appends a generic monospace fallback to an explicit family", () => {
    expect(resolveTerminalFontFamily("  IBM Plex Mono  ")).toBe("IBM Plex Mono, monospace");
    expect(resolveTerminalFontFamily("SFMono-Regular")).toBe("SFMono-Regular, monospace");
  });

  it("appends the fallback to a multi-family stack", () => {
    expect(resolveTerminalFontFamily("Iosevka, Menlo")).toBe("Iosevka, Menlo, monospace");
  });

  it("does not double up when the stack already ends in a generic monospace family", () => {
    expect(resolveTerminalFontFamily("Iosevka, monospace")).toBe("Iosevka, monospace");
    expect(resolveTerminalFontFamily("Iosevka, ui-monospace")).toBe("Iosevka, ui-monospace");
    expect(resolveTerminalFontFamily("Iosevka, 'monospace'")).toBe("Iosevka, 'monospace'");
    expect(resolveTerminalFontFamily(DEFAULT_TERMINAL_FONT_FAMILY)).toBe(
      DEFAULT_TERMINAL_FONT_FAMILY,
    );
  });
});

describe("resolveTerminalLineHeight", () => {
  it("defaults when unset or not a finite number", () => {
    expect(resolveTerminalLineHeight(undefined)).toBe(DEFAULT_TERMINAL_LINE_HEIGHT);
    expect(resolveTerminalLineHeight(Number.NaN)).toBe(DEFAULT_TERMINAL_LINE_HEIGHT);
    expect(resolveTerminalLineHeight(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TERMINAL_LINE_HEIGHT);
  });

  it("clamps below 1.0, where glyphs would clip against the cell", () => {
    expect(resolveTerminalLineHeight(0)).toBe(MIN_TERMINAL_LINE_HEIGHT);
    expect(resolveTerminalLineHeight(-3)).toBe(MIN_TERMINAL_LINE_HEIGHT);
    expect(resolveTerminalLineHeight(0.5)).toBe(MIN_TERMINAL_LINE_HEIGHT);
  });

  it("clamps above the maximum", () => {
    expect(resolveTerminalLineHeight(99)).toBe(MAX_TERMINAL_LINE_HEIGHT);
  });

  it("passes fractional values inside the range through", () => {
    expect(resolveTerminalLineHeight(1.25)).toBe(1.25);
  });
});

describe("resolveTerminalFontWeightBold", () => {
  // Only an explicit false disables bold; undefined must stay bold so an older
  // client or an unset value never silently flattens shell output.
  it("keeps bold unless explicitly disabled", () => {
    expect(resolveTerminalFontWeightBold(undefined)).toBe("bold");
    expect(resolveTerminalFontWeightBold(true)).toBe("bold");
  });

  it("matches the normal weight when bold text is off", () => {
    expect(resolveTerminalFontWeightBold(false)).toBe("normal");
  });
});
