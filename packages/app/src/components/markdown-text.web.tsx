import { useMemo, type ReactNode } from "react";
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";

interface MarkdownTextSpanProps {
  style?: StyleProp<TextStyle>;
  monoSurface?: boolean;
  children: ReactNode;
}

// react-native-web renders Text as <span>/<div> with `user-select: text`
// already applied via markdownStyleMapping. The web bundle must not import
// react-native-uitextview: its transitive import of codegenNativeComponent
// pulls in setUpReactDevTools, which doesn't resolve under Metro's web
// target in dev mode.
export function MarkdownTextSpan({ style, monoSurface, children }: MarkdownTextSpanProps) {
  return (
    <Text dataSet={monoSurface ? CODE_SURFACE_DATASET : undefined} style={style}>
      {children}
    </Text>
  );
}

interface MarkdownParagraphViewProps {
  paragraphStyle: ViewStyle;
  children: ReactNode;
}

const MARKDOWN_PARAGRAPH_RESET: ViewStyle = { marginBottom: 0 };

// Same shape as Android — paragraph is a View so block-level children (images)
// keep their natural layout. Web text selection already spans nested inline
// elements via CSS user-select, so no UITextView equivalent is needed.
export function MarkdownParagraphView({ paragraphStyle, children }: MarkdownParagraphViewProps) {
  const style = useMemo(() => [paragraphStyle, MARKDOWN_PARAGRAPH_RESET], [paragraphStyle]);
  return <View style={style}>{children}</View>;
}
