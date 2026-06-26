import { describe, expect, it } from "vitest";
import { darkTheme } from "@/styles/theme";
import { buildMermaidThemeKey, buildMermaidThemeVariables } from "./mermaid-theme";
import { renderMermaidSvg } from "./mermaid-runtime.web";

const mermaidThemeVariables = buildMermaidThemeVariables(darkTheme);
const mermaidThemeKey = buildMermaidThemeKey(mermaidThemeVariables);

describe("renderMermaidSvg", () => {
  it("renders valid Mermaid source to SVG", async () => {
    const svg = await renderMermaidSvg(
      `flowchart LR
  A[Start] --> B[End]`,
      mermaidThemeVariables,
      mermaidThemeKey,
    );

    expect(svg).toContain("<svg");
    expect(svg).toContain("Start");
    expect(svg).toContain("End");
  });

  it("rejects invalid Mermaid source", async () => {
    await expect(
      renderMermaidSvg("not valid mermaid [[[", mermaidThemeVariables, mermaidThemeKey),
    ).rejects.toThrow();
  });
});
