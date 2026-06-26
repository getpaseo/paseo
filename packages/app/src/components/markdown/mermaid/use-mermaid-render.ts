import type { MermaidThemeConfig } from "@/components/markdown/mermaid/mermaid-theme-config";
import type { MermaidRenderState } from "@/components/markdown/mermaid/use-mermaid-render-types";

export function useMermaidRender(
  _source: string,
  _mermaidTheme: MermaidThemeConfig,
  _onSvgChange?: (svg: string | null) => void,
): MermaidRenderState {
  return { svg: null, error: null, isRendering: false };
}
