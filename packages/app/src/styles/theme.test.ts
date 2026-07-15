import { describe, expect, it } from "vitest";
import { darkSolarizedTheme, darkTheme, THEME_SWATCHES, THEME_TO_UNISTYLES } from "./theme";

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  if (!channels || channels.length !== 3) throw new Error(`Invalid hex color: ${hex}`);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("Solarized Teal app theme", () => {
  it("registers a distinct selectable app theme without changing Paseo Dark", () => {
    expect(THEME_TO_UNISTYLES.solarized).toBe("darkSolarized");
    expect(THEME_SWATCHES.solarized).toBe("#2aa198");
    expect(darkTheme.colors.surface0).toBe("#181B1A");
    expect(darkTheme.colors.accent).toBe("#20744A");
  });

  it("uses the Solarized Teal chrome palette", () => {
    expect(darkSolarizedTheme.colorScheme).toBe("dark");
    expect(darkSolarizedTheme.colors).toMatchObject({
      surface0: "#002b36",
      surface1: "#073642",
      surface2: "#0a3b45",
      surface3: "#0a4548",
      surface4: "#93a1a1",
      surfaceDiffEmpty: "#012631",
      surfaceSidebar: "#00212b",
      surfaceSidebarHover: "#0a4c52",
      surfaceWorkspace: "#002b36",
      foreground: "#c9d6d3",
      foregroundMuted: "#93a1a1",
      foregroundExtraMuted: "#586e75",
      border: "#164852",
      borderAccent: "#586e7566",
      accent: "#2aa198",
      accentBright: "#55b8d8",
      accentForeground: "#002b36",
      ring: "#2aa19899",
      destructive: "#dc322f",
      success: "#859900",
      diffAddition: "#859900",
      diffDeletion: "#dc322f",
      statusSuccess: "#9fb900",
      statusDanger: "#ff746d",
      statusWarning: "#d5a800",
      statusMerged: "#9b9fe5",
    });
  });

  it("uses the canonical Solarized terminal palette", () => {
    expect(darkSolarizedTheme.colors.terminal).toEqual({
      background: "#002b36",
      foreground: "#e0e9e6",
      cursor: "#2aa198",
      cursorAccent: "#002b36",
      selectionBackground: "#274642",
      selectionForeground: "#e0e9e6",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    });
  });

  it("keeps small muted and destructive text at WCAG AA contrast", () => {
    const { colors } = darkSolarizedTheme;

    expect(contrastRatio(colors.foregroundMuted, colors.surface1)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.foregroundMuted, colors.surface2)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.destructiveForeground, colors.destructive)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrastRatio(colors.statusSuccess, colors.surface2)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.statusDanger, colors.surface2)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.statusWarning, colors.surface2)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.statusMerged, colors.surface2)).toBeGreaterThanOrEqual(4.5);
  });
});
