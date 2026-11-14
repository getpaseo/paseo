import { useMemo } from "react";
import type { MarkdownProps } from "@getpaseo/plugin/client/ui";
import { MermaidColorsContext } from "@/components/markdown/fence/mermaid";
import { mergeMermaidOptions } from "@/components/markdown/fence/mermaid/options";
import { MarkdownRenderer } from "@/components/markdown/renderer";

export function Markdown({ children, mermaid, mermaidColors }: MarkdownProps) {
  const options = useMemo(
    () => mergeMermaidOptions(mermaidColors, mermaid),
    [mermaid, mermaidColors],
  );
  return children ? (
    <MermaidColorsContext.Provider value={options}>
      <MarkdownRenderer text={children} />
    </MermaidColorsContext.Provider>
  ) : null;
}
