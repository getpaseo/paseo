import type { MermaidFrame } from "@getpaseo/plugin/client/ui";
import type { TextStyle } from "react-native";
export type MarkdownPhase = "streaming" | "complete";
export interface MarkdownFenceRendererProps {
  code: string;
  phase: MarkdownPhase;
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
  /** Preview-box chrome. The source view and fullscreen ignore it. */
  frame?: MermaidFrame;
}
