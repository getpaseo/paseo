import { describe, expect, it } from "vitest";
import { darkTheme, lightTheme } from "@/styles/theme";
import { buildMermaidThemeKey, buildMermaidThemeVariables } from "./mermaid-theme";

describe("buildMermaidThemeVariables", () => {
  it("marks dark mode from theme color scheme", () => {
    expect(buildMermaidThemeVariables(lightTheme).darkMode).toBe(false);
    expect(buildMermaidThemeVariables(darkTheme).darkMode).toBe(true);
  });

  it("uses surface and foreground tokens", () => {
    const variables = buildMermaidThemeVariables(lightTheme);
    expect(variables.background).toBe(lightTheme.colors.surface0);
    expect(variables.textColor).toBe(lightTheme.colors.foreground);
  });
});

describe("buildMermaidThemeKey", () => {
  it("is stable for the same variables", () => {
    const variables = buildMermaidThemeVariables(darkTheme);
    expect(buildMermaidThemeKey(variables)).toBe(buildMermaidThemeKey(variables));
  });
});
