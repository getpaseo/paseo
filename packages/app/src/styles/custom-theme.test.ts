import { describe, expect, it } from "vitest";
import { darkTheme } from "./theme";
import { buildCustomTheme, customThemeSchema } from "./custom-theme";

const ORCA_THEME = {
  version: 1,
  name: "Jon",
  appearance: "dark",
  colors: {
    background: "#222222",
    foreground: "#dbd7ca",
    raised: "#262626",
    control: "#2b2b2b",
    accent: "#393a34",
    highlight: "#e6cc77",
    mutedForeground: "#a9a397",
    ring: "#777777",
  },
} as const;

describe("customThemeSchema", () => {
  it("accepts a version 1 custom theme", () => {
    expect(customThemeSchema.parse(ORCA_THEME)).toEqual(ORCA_THEME);
  });

  it("rejects invalid color values", () => {
    const invalid = {
      ...ORCA_THEME,
      colors: { ...ORCA_THEME.colors, background: "red" },
    };

    expect(() => customThemeSchema.parse(invalid)).toThrow("Must be a hex color");
  });
});

describe("buildCustomTheme", () => {
  it("maps compact custom colors onto Paseo semantic and terminal tokens", () => {
    const theme = buildCustomTheme(customThemeSchema.parse(ORCA_THEME));

    expect(theme.colors).toMatchObject({
      surface0: "#222222",
      surface1: "#262626",
      surface2: "#2b2b2b",
      surfaceSidebar: "#222222",
      foreground: "#dbd7ca",
      foregroundMuted: "#a9a397",
      border: "#393a34",
      accent: "#e6cc77",
      accentBright: "#e6cc77",
      accentForeground: "#222222",
      ring: "#777777",
      terminal: {
        background: "#222222",
        foreground: "#dbd7ca",
        cursor: "#dbd7ca",
        cursorAccent: "#222222",
      },
    });
    expect(theme.colors.palette).toBe(darkTheme.colors.palette);
    expect(theme.colors.syntax).toBe(darkTheme.colors.syntax);
  });
});
