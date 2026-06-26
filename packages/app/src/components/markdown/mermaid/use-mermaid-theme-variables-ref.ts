import { useEffect, useRef, type RefObject } from "react";
import type { MermaidThemeVariables } from "@/components/markdown/mermaid/mermaid-theme";
import type { MermaidThemeConfig } from "@/components/markdown/mermaid/mermaid-theme-config";

/** Keeps latest theme variables for render payloads without putting object identity in effect deps. */
export function useMermaidThemeVariablesRef(mermaidTheme: MermaidThemeConfig): {
  themeKey: string;
  themeVariablesRef: RefObject<MermaidThemeVariables>;
} {
  const { key: themeKey, variables: themeVariables } = mermaidTheme;
  const themeVariablesRef = useRef(themeVariables);

  useEffect(() => {
    themeVariablesRef.current = themeVariables;
  }, [themeKey, themeVariables]);

  return { themeKey, themeVariablesRef };
}
