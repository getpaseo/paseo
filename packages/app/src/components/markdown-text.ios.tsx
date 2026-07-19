import { useMemo, type ReactNode } from "react";
import {
  Text,
  View,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { UITextView } from "react-native-uitextview";
import { resolvePlainMarkdownTextStyle } from "@/components/markdown-text-style";
import {
  iosMarkdownTextIsSelectable,
  useMarkdownTextSurface,
} from "@/components/markdown-text-selection";

interface MarkdownTextSpanProps {
  style?: StyleProp<TextStyle>;
  monoSurface?: boolean;
  children: ReactNode;
  // Links route through this span too (see assistant-file-links/link.tsx). A
  // plain <Text> nested in the paragraph UITextView is dropped, so the link
  // must be a UITextView span to be visible. onPress is wired onto the leaf
  // string children here: react-native-uitextview attaches it to the
  // RNUITextViewChild nodes it builds from string content, which the native tap
  // recognizer dispatches to. The link's handler reaches these leaf spans via
  // AssistantLinkPressProvider (see assistant-file-links/link-press-context).
  onPress?: TextProps["onPress"];
  accessibilityRole?: TextProps["accessibilityRole"];
}

// Inline span backed by UITextView so iOS gets native word-selection handles.
// Used inside MarkdownParagraphView (which is also a UITextView on iOS); the
// library's TextAncestorContext hoists these into UITextViewChild nodes so
// selection drags can cross sibling spans (e.g. plain text → **bold** → code).
export function MarkdownTextSpan({
  style,
  children,
  onPress,
  accessibilityRole,
}: MarkdownTextSpanProps) {
  const plainStyle = useMemo(() => resolvePlainMarkdownTextStyle(style), [style]);
  const surface = useMarkdownTextSurface();

  // Each selectable span creates a UIKit UITextView with a window-level tap recognizer.
  // A large table would create one per cell and make every app touch fan out across them.
  if (!iosMarkdownTextIsSelectable(surface)) {
    return (
      <Text
        selectable={false}
        style={plainStyle}
        onPress={onPress}
        accessibilityRole={accessibilityRole}
      >
        {children}
      </Text>
    );
  }

  return (
    <UITextView
      uiTextView
      selectable
      style={plainStyle}
      onPress={onPress}
      accessibilityRole={accessibilityRole}
    >
      {children}
    </UITextView>
  );
}

interface MarkdownParagraphViewProps {
  paragraphStyle: ViewStyle;
  containsImage?: boolean;
  children: ReactNode;
}

const MARKDOWN_PARAGRAPH_RESET: ViewStyle = {};

// iOS-only: paragraph wraps in UITextView so the entire paragraph is one
// native text view. That's what unlocks cross-inline drag selection — handles
// can span every MarkdownTextSpan child inside this paragraph.
// ViewStyle is structurally compatible with the layout props paragraphs use
// (margin, padding, alignment); the cast lets the existing paragraphStyle
// flow through unchanged.
export function MarkdownParagraphView({
  paragraphStyle,
  containsImage = false,
  children,
}: MarkdownParagraphViewProps) {
  const textStyle = useMemo(
    () =>
      resolvePlainMarkdownTextStyle([
        paragraphStyle,
        MARKDOWN_PARAGRAPH_RESET,
      ] as StyleProp<TextStyle>),
    [paragraphStyle],
  );
  const viewStyle = useMemo(() => [paragraphStyle, MARKDOWN_PARAGRAPH_RESET], [paragraphStyle]);

  if (containsImage) {
    return <View style={viewStyle}>{children}</View>;
  }

  return (
    <UITextView uiTextView selectable style={textStyle}>
      {children}
    </UITextView>
  );
}
