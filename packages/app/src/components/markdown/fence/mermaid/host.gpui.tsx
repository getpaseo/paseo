import { Text, View } from "react-native";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import type { MarkdownFenceRendererProps } from "./types";

export function MermaidFenceHost({ code, inheritedStyles, textStyle }: MarkdownFenceRendererProps) {
  return (
    <View>
      <Text style={inheritedStyles}>Diagram rendering is not available in the GPUI build yet.</Text>
      <HighlightedCodeBlock
        code={code}
        language="mermaid"
        inheritedStyles={inheritedStyles}
        textStyle={textStyle}
      />
    </View>
  );
}
