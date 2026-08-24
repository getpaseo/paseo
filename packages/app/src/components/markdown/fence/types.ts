import type { TextStyle } from "react-native";

export type MarkdownPhase = "streaming" | "complete";

export interface MarkdownFenceRendererProps {
  code: string;
  phase: MarkdownPhase;
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
}
