import { useEffect, useRef, useState } from "react";
import { useUnistyles } from "react-native-unistyles";
import {
  buildMermaidThemeKey,
  buildMermaidThemeVariables,
} from "@/components/markdown/mermaid/mermaid-theme";
import { renderMermaidSvg } from "@/components/markdown/mermaid/mermaid-runtime.web";
import type { MermaidRenderState } from "@/components/markdown/mermaid/use-mermaid-render-types";

const MERMAID_RENDER_DEBOUNCE_MS = 250;

export function useMermaidRender(source: string): MermaidRenderState {
  const { theme } = useUnistyles();
  const themeVariables = buildMermaidThemeVariables(theme);
  const themeKey = buildMermaidThemeKey(themeVariables);
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
      void renderMermaidSvg(trimmed, themeVariables, themeKey)
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
  }, [source, themeKey, themeVariables]);

  return state;
}
