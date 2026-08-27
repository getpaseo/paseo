import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import type { MarkdownFenceRendererProps } from "../types";

export function MermaidFenceHost({ code, inheritedStyles, textStyle }: MarkdownFenceRendererProps) {
  return (
    <HighlightedCodeBlock
      code={code}
      language="mermaid"
      inheritedStyles={inheritedStyles}
      textStyle={textStyle}
    />
  );
}
