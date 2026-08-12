import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLIENT_SETTINGS,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  normalizeAppSettings,
  parseTerminalFontSize,
  parseTerminalLineHeight,
  TERMINAL_FONT_SIZE_INHERIT,
} from "./storage";
import { DEFAULT_TERMINAL_LINE_HEIGHT } from "@/terminal/runtime/terminal-font";

describe("parseTerminalFontSize", () => {
  // Zero is not "invalid" here — it is the sentinel meaning "follow codeFontSize",
  // so it must survive rather than being clamped up to the minimum.
  it("treats zero and negatives as inherit", () => {
    expect(parseTerminalFontSize(0)).toBe(TERMINAL_FONT_SIZE_INHERIT);
    expect(parseTerminalFontSize(-5)).toBe(TERMINAL_FONT_SIZE_INHERIT);
  });

  it("clamps explicit sizes into range", () => {
    expect(parseTerminalFontSize(1)).toBe(MIN_TERMINAL_FONT_SIZE);
    expect(parseTerminalFontSize(999)).toBe(MAX_TERMINAL_FONT_SIZE);
    expect(parseTerminalFontSize(14)).toBe(14);
  });

  it("accepts numeric strings and floors them", () => {
    expect(parseTerminalFontSize("15")).toBe(15);
    expect(parseTerminalFontSize("15.9")).toBe(15);
  });

  it("rejects non-numeric input so the stored value is left alone", () => {
    expect(parseTerminalFontSize("abc")).toBeNull();
    expect(parseTerminalFontSize(null)).toBeNull();
    expect(parseTerminalFontSize({})).toBeNull();
  });
});

describe("parseTerminalLineHeight", () => {
  it("keeps fractional values, unlike the integer font sizes", () => {
    expect(parseTerminalLineHeight(1.25)).toBe(1.25);
    expect(parseTerminalLineHeight("1.35")).toBe(1.35);
  });

  it("clamps out-of-range values", () => {
    expect(parseTerminalLineHeight(0.2)).toBe(1);
    expect(parseTerminalLineHeight(50)).toBe(2);
  });

  it("rejects non-numeric input", () => {
    expect(parseTerminalLineHeight("wide")).toBeNull();
    expect(parseTerminalLineHeight(undefined)).toBeNull();
  });
});

describe("terminal typography defaults", () => {
  it("ships inherit-size so upgrading users keep tracking the code font size", () => {
    expect(DEFAULT_CLIENT_SETTINGS.terminalFontSize).toBe(TERMINAL_FONT_SIZE_INHERIT);
    expect(DEFAULT_CLIENT_SETTINGS.terminalFontFamily).toBe("");
    expect(DEFAULT_CLIENT_SETTINGS.terminalLineHeight).toBe(DEFAULT_TERMINAL_LINE_HEIGHT);
  });

  it("normalizes stored terminal typography", () => {
    const normalized = normalizeAppSettings({
      terminalFontFamily: "  Iosevka  ",
      terminalFontSize: "18",
      terminalLineHeight: "1.5",
    });
    expect(normalized.terminalFontFamily).toBe("Iosevka");
    expect(normalized.terminalFontSize).toBe(18);
    expect(normalized.terminalLineHeight).toBe(1.5);
  });

  it("drops a font family that would break the CSS font-family declaration", () => {
    const normalized = normalizeAppSettings({ terminalFontFamily: "Evil; content: x" });
    expect(normalized.terminalFontFamily).toBe(DEFAULT_CLIENT_SETTINGS.terminalFontFamily);
  });
});
