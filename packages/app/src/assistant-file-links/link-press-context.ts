import { createContext, useContext } from "react";
import type { TextProps } from "react-native";

// Carries a link's press handler down to the leaf text spans that render its
// label. On iOS an assistant link is a nested UITextView span, and
// react-native-uitextview only attaches onPress to the *string* children it
// converts into RNUITextViewChild nodes (src/Text.tsx) — element children (the
// MarkdownInheritedText spans markdown produces for link text) pass through
// untouched, so an onPress placed on the wrapping span never reaches a tappable
// native node. Threading the handler through context lets each leaf span hand
// onPress to its own string children, where the native tap recognizer can find
// it. Provided only on iOS (Android/web links tap fine via their own paths).
export interface AssistantLinkPress {
  onPress: () => void;
  accessibilityRole?: TextProps["accessibilityRole"];
}

const AssistantLinkPressContext = createContext<AssistantLinkPress | null>(null);

export const AssistantLinkPressProvider = AssistantLinkPressContext.Provider;

export function useAssistantLinkPress(): AssistantLinkPress | null {
  return useContext(AssistantLinkPressContext);
}
