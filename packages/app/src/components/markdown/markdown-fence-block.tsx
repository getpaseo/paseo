import type { TextStyle } from "react-native";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { isMermaidFenceLanguage } from "@/components/markdown/fence-language";
import { MermaidFenceBlock } from "@/components/markdown/mermaid/mermaid-fence-block";

export interface MarkdownFenceBlockProps {
  code: string;
  language: string | null | undefined;
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
}

export function MarkdownFenceBlock({
  code,
  language,
  inheritedStyles,
  textStyle,
}: MarkdownFenceBlockProps) {
  if (isMermaidFenceLanguage(language)) {
    return (
      <MermaidFenceBlock code={code} inheritedStyles={inheritedStyles} textStyle={textStyle} />
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
