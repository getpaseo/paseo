import type { MermaidThemeVariables } from "@/components/markdown/mermaid/mermaid-theme";

export async function renderMermaidSvg(
  _source: string,
  _themeVariables: MermaidThemeVariables,
  _themeKey: string,
): Promise<string> {
  throw new Error("Mermaid rendering is not available on this platform");
}
