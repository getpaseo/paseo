import { useMemo, type ReactNode } from "react";
import {
  Text,
  View,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { markdownCopyDataSet, type MarkdownCopyInlineTag } from "@/assistant-selection-copy/markup";

interface MarkdownTextSpanProps {
  style?: StyleProp<TextStyle>;
  monoSurface?: boolean;
  copyTag?: MarkdownCopyInlineTag;
  children: ReactNode;
  // Web links use the <a>/Pressable path in link.tsx, not this span, so these
  // are accepted for prop-shape parity with the native variants and forwarded
  // harmlessly.
  onPress?: TextProps["onPress"];
  accessibilityRole?: TextProps["accessibilityRole"];
}

// react-native-web renders Text as <span>/<div> with `user-select: text`
// already applied via markdownStyleMapping. The web bundle must not import
// react-native-uitextview: its transitive import of codegenNativeComponent
// pulls in setUpReactDevTools, which doesn't resolve under Metro's web
// target in dev mode.
export function MarkdownTextSpan({
  style,
  monoSurface,
  copyTag,
  children,
  onPress,
  accessibilityRole,
}: MarkdownTextSpanProps) {
  const dataSet = useMemo(() => {
    if (copyTag) {
      return { ...CODE_SURFACE_DATASET, ...markdownCopyDataSet[copyTag] };
    }
    return monoSurface ? CODE_SURFACE_DATASET : undefined;
  }, [copyTag, monoSurface]);

  return (
    <Text dataSet={dataSet} style={style} onPress={onPress} accessibilityRole={accessibilityRole}>
      {children}
    </Text>
  );
}

interface MarkdownParagraphViewProps {
  paragraphStyle: ViewStyle;
  containsImage?: boolean;
  children: ReactNode;
}

const MARKDOWN_PARAGRAPH_RESET: ViewStyle = {};

// Same shape as Android — paragraph is a View so block-level children (images)
// keep their natural layout. Web text selection already spans nested inline
// elements via CSS user-select, so no UITextView equivalent is needed.
export function MarkdownParagraphView({ paragraphStyle, children }: MarkdownParagraphViewProps) {
  const style = useMemo(() => [paragraphStyle, MARKDOWN_PARAGRAPH_RESET], [paragraphStyle]);
  return (
    <View style={style} dataSet={markdownCopyDataSet.p}>
      {children}
    </View>
  );
}
