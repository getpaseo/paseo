import type { RefObject } from "react";
import type { ScrollView, View } from "react-native";

export interface MarkdownPreviewFindProps {
  /** The rendered document Find searches. */
  content: RefObject<View | null>;
  /** The scroll view around it, which Find scrolls to reveal a match. */
  scroller: RefObject<ScrollView | null>;
}
