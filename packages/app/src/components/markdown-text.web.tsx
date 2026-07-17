import { useImperativeHandle, useMemo, useRef, type ReactNode, type Ref } from "react";
import {
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";

interface MarkdownTextSpanProps {
  style?: StyleProp<TextStyle>;
  monoSurface?: boolean;
  children: ReactNode;
  // Web links use the <a>/Pressable path in link.tsx, not this span, so these
  // are accepted for prop-shape parity with the native variants and forwarded
  // harmlessly.
  onPress?: TextProps["onPress"];
  accessibilityRole?: TextProps["accessibilityRole"];
  measureRef?: Ref<MarkdownTextSpanMeasureHandle>;
  onLayout?: (event: LayoutChangeEvent) => void;
}

export interface MarkdownTextSpanMeasureHandle {
  measureInWindow: (
    callback: (x: number, y: number, width: number, height: number) => void,
  ) => void;
}

// react-native-web renders Text as <span>/<div> with `user-select: text`
// already applied via markdownStyleMapping. The web bundle must not import
// react-native-uitextview: its transitive import of codegenNativeComponent
// pulls in setUpReactDevTools, which doesn't resolve under Metro's web
// target in dev mode.
export function MarkdownTextSpan({
  style,
  monoSurface,
  children,
  onPress,
  accessibilityRole,
  measureRef,
  onLayout,
}: MarkdownTextSpanProps) {
  const textRef = useRef<Text>(null);
  useImperativeHandle(
    measureRef,
    () => ({ measureInWindow: (callback) => textRef.current?.measureInWindow(callback) }),
    [],
  );
  return (
    <Text
      ref={textRef}
      dataSet={monoSurface ? CODE_SURFACE_DATASET : undefined}
      style={style}
      onPress={onPress}
      accessibilityRole={accessibilityRole}
      onLayout={onLayout}
    >
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
  return <View style={style}>{children}</View>;
}
