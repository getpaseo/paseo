import { describe, expect, it } from "vitest";
import { darkTheme, lightTheme } from "@/styles/theme";
import { buildMermaidThemeKey, buildMermaidThemeVariables } from "./mermaid-theme";

function parseHexColor(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "").trim();
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((c) => c + c)
          .join("")
      : normalized;
  const r = Number.parseInt(expanded.slice(0, 2), 16);
  const g = Number.parseInt(expanded.slice(2, 4), 16);
  const b = Number.parseInt(expanded.slice(4, 6), 16);
  return [r, g, b];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHexColor(hex).map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("buildMermaidThemeVariables", () => {
  it("marks dark mode from theme color scheme", () => {
    expect(buildMermaidThemeVariables(lightTheme).darkMode).toBe(false);
    expect(buildMermaidThemeVariables(darkTheme).darkMode).toBe(true);
  });

  it("uses readable diagram palette instead of low-contrast app border tokens", () => {
    const light = buildMermaidThemeVariables(lightTheme);
    const dark = buildMermaidThemeVariables(darkTheme);

    expect(light.background).not.toBe(lightTheme.colors.surface0);
    expect(light.lineColor).not.toBe(lightTheme.colors.border);
    expect(dark.lineColor).not.toBe(darkTheme.colors.border);

    expect(contrastRatio(light.lineColor, light.background)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(dark.lineColor, dark.background)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(light.primaryTextColor, light.primaryColor)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.primaryTextColor, dark.primaryColor)).toBeGreaterThanOrEqual(4.5);
  });

  it("sets edge and cluster fills for legible labels", () => {
    for (const theme of [lightTheme, darkTheme]) {
      const variables = buildMermaidThemeVariables(theme);
      expect(variables.edgeLabelBackground.toLowerCase()).not.toBe("#000000");
      expect(variables.edgeLabelBackground.toLowerCase()).not.toBe("black");
      expect(variables.clusterBkg).not.toBe(variables.background);
      expect(variables.nodeBorder).toBe(variables.primaryBorderColor);
      expect(variables.defaultLinkColor).toBe(variables.lineColor);
    }
  });
});

describe("buildMermaidThemeKey", () => {
  it("is stable for the same variables", () => {
    const variables = buildMermaidThemeVariables(darkTheme);
    expect(buildMermaidThemeKey(variables)).toBe(buildMermaidThemeKey(variables));
  });
});
