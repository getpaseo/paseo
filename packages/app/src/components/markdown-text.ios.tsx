import { useMemo, type ReactNode } from "react";
import { View, type StyleProp, type TextProps, type TextStyle, type ViewStyle } from "react-native";
import { UITextView } from "react-native-uitextview";

interface MarkdownTextSpanProps {
  style?: StyleProp<TextStyle>;
  monoSurface?: boolean;
  children: ReactNode;
  // Links route through this span too (see assistant-file-links/link.tsx). A
  // plain <Text> nested in the paragraph UITextView is dropped, so the link
  // must be a UITextView span to be visible. onPress is forwarded best-effort:
  // react-native-uitextview nulls onPress on the root native view, so reliable
  // tap-to-open is still tracked by #21 — but visible+selectable text beats an
  // invisible link.
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
  return (
    <UITextView
      uiTextView
      selectable
      style={style}
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

const MARKDOWN_PARAGRAPH_RESET: ViewStyle = { marginBottom: 0 };

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
    () => [paragraphStyle, MARKDOWN_PARAGRAPH_RESET] as StyleProp<TextStyle>,
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
