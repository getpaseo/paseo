import type { TextStyle } from "react-native";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";

export interface MermaidDiagramProps {
  code: string;
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
}

// ponytail: native shows the mermaid source as a plain code block. If phone
// users ask for rendered diagrams, add mermaid-diagram.native.tsx wrapping
// react-native-webview with mermaid bundled as a local asset.
export function MermaidDiagram({ code, inheritedStyles, textStyle }: MermaidDiagramProps) {
  return (
    <HighlightedCodeBlock
      code={code}
      language="mermaid"
      inheritedStyles={inheritedStyles}
      textStyle={textStyle}
    />
  );
}
