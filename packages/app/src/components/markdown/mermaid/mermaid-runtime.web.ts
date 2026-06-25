import type { Mermaid } from "mermaid";
import type { MermaidThemeVariables } from "@/components/markdown/mermaid/mermaid-theme";

let mermaidModule: Mermaid | null = null;
let initThemeKey: string | null = null;

async function loadMermaid(): Promise<Mermaid> {
  if (mermaidModule) {
    return mermaidModule;
  }
  const imported = await import("mermaid");
  mermaidModule = imported.default;
  return mermaidModule;
}

export async function renderMermaidSvg(
  source: string,
  themeVariables: MermaidThemeVariables,
  themeKey: string,
): Promise<string> {
  const mermaid = await loadMermaid();
  if (initThemeKey !== themeKey) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables,
    });
    initThemeKey = themeKey;
  }

  const id = `paseo-mermaid-${Math.random().toString(36).slice(2)}`;
  const { svg } = await mermaid.render(id, source);
  return svg;
}
