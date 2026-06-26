import { useEffect, useRef, useState } from "react";
import type { MermaidThemeConfig } from "@/components/markdown/mermaid/mermaid-theme-config";
import { useMermaidThemeVariablesRef } from "@/components/markdown/mermaid/use-mermaid-theme-variables-ref";
import { renderMermaidSvg } from "@/components/markdown/mermaid/mermaid-runtime.web";
import type { MermaidRenderState } from "@/components/markdown/mermaid/use-mermaid-render-types";

const MERMAID_RENDER_DEBOUNCE_MS = 250;

export function useMermaidRender(
  source: string,
  mermaidTheme: MermaidThemeConfig,
): MermaidRenderState {
  const { themeKey, themeVariablesRef } = useMermaidThemeVariablesRef(mermaidTheme);
  const [state, setState] = useState<MermaidRenderState>({
    svg: null,
    error: null,
    isRendering: false,
  });
  const requestIdRef = useRef(0);

  useEffect(() => {
    const trimmed = source.trim();
    if (trimmed.length === 0) {
      setState({ svg: null, error: null, isRendering: false });
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState((current) => ({ ...current, isRendering: true, error: null }));

    const timeout = setTimeout(() => {
      void renderMermaidSvg(trimmed, themeVariablesRef.current, themeKey)
        .then((svg) => {
          if (requestIdRef.current !== requestId) {
            return undefined;
          }
          setState({ svg, error: null, isRendering: false });
          return undefined;
        })
        .catch((error: unknown) => {
          if (requestIdRef.current !== requestId) {
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          setState({ svg: null, error: message, isRendering: false });
        });
    }, MERMAID_RENDER_DEBOUNCE_MS);

    return () => {
      clearTimeout(timeout);
    };
  }, [source, themeKey, themeVariablesRef]);

  return state;
}
