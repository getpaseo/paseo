import { useMemo, type ReactNode } from "react";
import {
  ScrollView,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { AppearanceStyleBoundary } from "@/components/appearance-style-boundary";
import { isWeb } from "@/constants/platform";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

type CodeSurfaceTone = "surface0" | "surface1" | "surface2";

interface ScrollableCodeSurfaceProps {
  children: ReactNode;
  maxHeight?: number;
  horizontal?: boolean;
  selectable?: boolean;
  tone?: CodeSurfaceTone;
  bordered?: boolean;
  style?: StyleProp<ViewStyle>;
  scrollStyle?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  testID?: string;
  accessibilityLabel?: string;
}

interface SurfaceCardProps {
  children: ReactNode;
  tone?: CodeSurfaceTone;
  bordered?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
  codeSurface?: boolean;
}

export function SurfaceCard({
  children,
  tone = "surface1",
  bordered = true,
  style,
  testID,
  accessibilityLabel,
  codeSurface = false,
}: SurfaceCardProps) {
  const surfaceStyle = getSurfaceStyle(tone);
  const containerStyle = useMemo(
    () => [styles.container, surfaceStyle, bordered && styles.bordered, style],
    [bordered, style, surfaceStyle],
  );

  const surface = (
    <View
      style={containerStyle}
      dataSet={codeSurface ? CODE_SURFACE_DATASET : undefined}
      testID={testID}
      accessible={accessibilityLabel != null}
      accessibilityLabel={accessibilityLabel}
    >
      {children}
    </View>
  );
  return <AppearanceStyleBoundary>{surface}</AppearanceStyleBoundary>;
}

export function ScrollableCodeSurface({
  children,
  maxHeight,
  horizontal = true,
  selectable = true,
  tone = "surface1",
  bordered = true,
  style,
  scrollStyle,
  contentContainerStyle,
  textStyle,
  testID,
  accessibilityLabel,
}: ScrollableCodeSurfaceProps) {
  const maxHeightStyle = useMemo(
    () => (maxHeight == null ? null : inlineUnistylesStyle({ maxHeight })),
    [maxHeight],
  );
  const outerScrollStyle = useMemo(
    () => [maxHeightStyle, scrollStyle],
    [maxHeightStyle, scrollStyle],
  );
  const contentStyle = useMemo(
    () => [styles.content, contentContainerStyle],
    [contentContainerStyle],
  );
  const codeTextStyle = useMemo(() => [styles.text, textStyle], [textStyle]);
  const codeContent =
    typeof children === "string" ? (
      <PlainCodeText text={children} selectable={selectable} textStyle={codeTextStyle} />
    ) : (
      <Text selectable={selectable} style={codeTextStyle} dataSet={CODE_SURFACE_DATASET}>
        {children}
      </Text>
    );

  return (
    <SurfaceCard
      tone={tone}
      bordered={bordered}
      style={style}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      codeSurface
    >
      <ScrollView
        style={outerScrollStyle}
        contentContainerStyle={contentStyle}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        {horizontal ? (
          <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
            {codeContent}
          </ScrollView>
        ) : (
          codeContent
        )}
      </ScrollView>
    </SurfaceCard>
  );
}

function PlainCodeText({
  text,
  selectable,
  textStyle,
}: {
  text: string;
  selectable: boolean;
  textStyle: StyleProp<TextStyle>;
}) {
  const lines = useMemo(() => {
    let offset = 0;
    return text.split("\n").map((line) => {
      const key = `${offset}:${line.length}`;
      offset += line.length + 1;
      return { key, line };
    });
  }, [text]);
  return (
    <View dataSet={CODE_SURFACE_DATASET}>
      {lines.map(({ key, line }) => (
        <Text key={key} selectable={selectable} style={textStyle} dataSet={CODE_SURFACE_DATASET}>
          {line.length === 0 ? "\u200B" : line}
        </Text>
      ))}
    </View>
  );
}

function getSurfaceStyle(tone: CodeSurfaceTone): StyleProp<ViewStyle> {
  switch (tone) {
    case "surface0":
      return styles.surface0;
    case "surface2":
      return styles.surface2;
    case "surface1":
      return styles.surface1;
  }
}

const styles = StyleSheet.create((theme) => ({
  container: {
    overflow: "hidden",
  },
  bordered: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  surface0: {
    backgroundColor: theme.colors.surface0,
  },
  surface1: {
    backgroundColor: theme.colors.surface1,
  },
  surface2: {
    backgroundColor: theme.colors.surface2,
  },
  content: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  text: {
    backgroundColor: "transparent",
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
    lineHeight: 18,
    ...(isWeb
      ? {
          whiteSpace: "pre",
          overflowWrap: "normal",
        }
      : null),
  },
}));
