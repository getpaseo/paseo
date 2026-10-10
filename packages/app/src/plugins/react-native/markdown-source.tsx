import { useMemo, type ReactNode } from "react";
import { View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { MARKDOWN_COPY_SOURCE_DATASET_KEY } from "@/assistant-selection-copy/markup";

const SELECT_AS_UNIT = { userSelect: "all" } as const;

export interface MarkdownSourceProps {
  source: string;
  display?: boolean;
  style?: StyleProp<ViewStyle | TextStyle>;
  children?: ReactNode;
}

// Native has no caret and no DOM selection. The host is always View so a plugin can pass
// view-backed children (SvgXml) without nesting them under Text, which iOS and Android reject.
export function MarkdownSource({ source, style, children }: MarkdownSourceProps) {
  const dataSet = useMemo(() => ({ [MARKDOWN_COPY_SOURCE_DATASET_KEY]: source }), [source]);
  return (
    <View
      style={[style as StyleProp<ViewStyle>, SELECT_AS_UNIT as ViewStyle]}
      dataSet={dataSet}
      accessibilityLabel={source}
    >
      {children}
    </View>
  );
}
