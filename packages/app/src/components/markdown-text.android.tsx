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

interface MarkdownTextSpanProps {
  style?: StyleProp<TextStyle>;
  monoSurface?: boolean;
  children: ReactNode;
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

// Android's <Text selectable> enables per-text-node selection natively. Each
// sibling Text is its own selection scope — drag can't span across siblings
// (that requires a single UITextView ancestor and is iOS-only). onPress works
// natively here, so links routed through this span stay tappable on Android.
export function MarkdownTextSpan({
  style,
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
      selectable
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

// Paragraph stays a <View>, not a <Text>, for layout fidelity. RN Android's
// text engine *does* accept inline View children (TextInlineViewPlaceholderSpan
// in ReactBaseTextShadowNode), so this isn't a crash-avoidance choice — but
// inline-placeholder spans collapse block-level children (e.g. paragraph
// images) into one-character placeholders, which destroys image row layout.
// <View> preserves the original block layout; the trade-off is no cross-span
// selection on Android (a UITextView-style trick has no Android equivalent).
export function MarkdownParagraphView({ paragraphStyle, children }: MarkdownParagraphViewProps) {
  const style = useMemo(() => [paragraphStyle, MARKDOWN_PARAGRAPH_RESET], [paragraphStyle]);
  return <View style={style}>{children}</View>;
}
