import React, { useState, useCallback, useMemo } from "react";
import {
  Text,
  Pressable,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
  type LayoutChangeEvent,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { ICON_SIZE, type Theme } from "@/styles/theme";

interface CollapsibleTextProps {
  text: string;
  maxCollapsedLines?: number;
  maxCollapsedChars?: number;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  expandLabel?: string;
  collapseLabel?: string;
  testID?: string;
}

import {
  PASTE_COLLAPSE_MIN_CHARS,
  PASTE_COLLAPSE_MIN_LINES,
  formatPastedTextSummary,
  shouldCollapsePastedText,
} from "@/composer/attachments/pasted-text";

export {
  PASTE_COLLAPSE_MIN_CHARS,
  PASTE_COLLAPSE_MIN_LINES,
  formatPastedTextSummary,
  shouldCollapsePastedText,
};
export const DEFAULT_MAX_LINES = PASTE_COLLAPSE_MIN_LINES;
export const DEFAULT_MAX_CHARS = PASTE_COLLAPSE_MIN_CHARS;

export function CollapsibleText({
  text,
  maxCollapsedLines = DEFAULT_MAX_LINES,
  maxCollapsedChars = DEFAULT_MAX_CHARS,
  style,
  containerStyle,
  expandLabel = "Show more",
  collapseLabel = "Show less",
  testID,
}: CollapsibleTextProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);

  const lines = useMemo(() => text.split("\n"), [text]);
  const isLikelyLong = text.length > maxCollapsedChars || lines.length > maxCollapsedLines;

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const onTextLayout = useCallback(
    (e: LayoutChangeEvent | { nativeEvent: { lines?: unknown[] } }) => {
      // In React Native / Web onTextLayout provides lines array
      const linesArray = "lines" in e.nativeEvent ? (e.nativeEvent.lines as unknown[]) : undefined;
      if (linesArray && linesArray.length > maxCollapsedLines) {
        setHasOverflow(true);
      }
    },
    [maxCollapsedLines],
  );

  const showToggleButton = isLikelyLong || hasOverflow;

  return (
    <View style={containerStyle} testID={testID}>
      <Text
        selectable
        style={style}
        numberOfLines={isExpanded ? undefined : maxCollapsedLines}
        onTextLayout={onTextLayout}
      >
        {text}
      </Text>
      {showToggleButton ? (
        <Pressable
          onPress={toggleExpanded}
          style={styles.toggleButton}
          accessibilityRole="button"
          accessibilityLabel={isExpanded ? collapseLabel : expandLabel}
          testID={testID ? `${testID}-toggle` : "collapsible-text-toggle"}
        >
          <Text style={styles.toggleLabel}>{isExpanded ? collapseLabel : expandLabel}</Text>
          {isExpanded ? (
            <ThemedChevronUp size={ICON_SIZE.xs} uniProps={iconForegroundMutedMapping} />
          ) : (
            <ThemedChevronDown size={ICON_SIZE.xs} uniProps={iconForegroundMutedMapping} />
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);

const iconForegroundMutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const styles = StyleSheet.create((theme) => ({
  toggleButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: theme.spacing[2],
    alignSelf: "flex-start",
    paddingVertical: 2,
    paddingHorizontal: 4,
    borderRadius: theme.borderRadius.sm,
  },
  toggleLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
}));
