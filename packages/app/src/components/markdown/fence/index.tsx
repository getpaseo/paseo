import type { ComponentType } from "react";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { getMarkdownFenceLanguage } from "./language";
import { MermaidFence } from "./mermaid";
import type { MarkdownFenceRendererProps } from "./types";

export interface MarkdownFenceBlockProps extends MarkdownFenceRendererProps {
  info: string | null | undefined;
}

const diagramFences: Partial<Record<string, ComponentType<MarkdownFenceRendererProps>>> = {
  mermaid: MermaidFence,
};

export function MarkdownFenceBlock({
  code,
  info,
  phase,
  inheritedStyles,
  textStyle,
}: MarkdownFenceBlockProps) {
  const language = getMarkdownFenceLanguage(info);
  const DiagramFence = language ? diagramFences[language] : undefined;
  if (DiagramFence) {
    return (
      <DiagramFence
        code={code}
        phase={phase}
        inheritedStyles={inheritedStyles}
        textStyle={textStyle}
      />
    );
  }
  return (
    <HighlightedCodeBlock
      code={code}
      language={language}
      inheritedStyles={inheritedStyles}
      textStyle={textStyle}
    />
  );
}
