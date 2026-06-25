import type { MermaidRenderState } from "@/components/markdown/mermaid/use-mermaid-render-types";

export function useMermaidRender(_source: string): MermaidRenderState {
  return { svg: null, error: null, isRendering: false };
}
