import React, { useMemo, type CSSProperties, type ReactNode } from "react";
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import {
  MARKDOWN_COPY_SOURCE_ATTRIBUTE,
  MARKDOWN_COPY_SOURCE_DATASET_KEY,
} from "@/assistant-selection-copy/markup";

const SELECT_AS_UNIT = { userSelect: "all" } as const;
// Absolute so it cannot take a line of its own in the display branch's column layout.
const CARET_ANCHOR = { position: "absolute" } as const;
const ZERO_WIDTH_SPACE = "​";

export interface MarkdownSourceProps {
  source: string;
  display?: boolean;
  style?: StyleProp<ViewStyle | TextStyle>;
  children?: ReactNode;
}

// Wrapped content is usually drawn rather than written — a rendered formula's SVG, say — so the
// wrapper often holds no text of its own. A browser selection anchors to a text position, and
// without one inside the wrapper a press anchors at the nearest text instead: in the next block
// entirely for display content, or just past the element for inline content. Either way the
// selection excludes the wrapper and its source never reaches the clipboard. A zero-width space
// supplies the missing position, and `userSelect: "all"` widens it to the whole wrapper.
//
// Inline content is a real `<span>` so Turndown keeps adjacent spaces even when there is no Text
// ancestor. react-native-web's Text would emit a div in that case, which Turndown treats as a
// block and strips the whitespace around. Display content wants exactly that block behavior.
export function MarkdownSource({ source, display = false, style, children }: MarkdownSourceProps) {
  const dataSet = useMemo(() => ({ [MARKDOWN_COPY_SOURCE_DATASET_KEY]: source }), [source]);
  if (display) {
    return (
      <View
        style={[style as StyleProp<ViewStyle>, SELECT_AS_UNIT as ViewStyle]}
        dataSet={dataSet}
        accessibilityLabel={source}
      >
        <Text style={CARET_ANCHOR}>{ZERO_WIDTH_SPACE}</Text>
        {children}
      </View>
    );
  }
  const sourceAttribute = { [MARKDOWN_COPY_SOURCE_ATTRIBUTE]: source };
  return (
    <span
      style={StyleSheet.flatten([style, SELECT_AS_UNIT]) as CSSProperties}
      {...sourceAttribute}
      aria-label={source}
    >
      {ZERO_WIDTH_SPACE}
      {children}
    </span>
  );
}
