import React, { useState, useCallback, useMemo } from "react";
import {
  Text,
  Pressable,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
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

const DEFAULT_MAX_LINES = 8;
const DEFAULT_MAX_CHARS = 400;

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

  const lines = useMemo(() => text.split("\n"), [text]);
  const isTooLong = text.length > maxCollapsedChars || lines.length > maxCollapsedLines;

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const displayText = useMemo(() => {
    if (!isTooLong || isExpanded) return text;
    if (lines.length > maxCollapsedLines) {
      return `${lines.slice(0, maxCollapsedLines).join("\n")}...`;
    }
    return `${text.slice(0, maxCollapsedChars)}...`;
  }, [isExpanded, isTooLong, lines, maxCollapsedChars, maxCollapsedLines, text]);

  if (!isTooLong) {
    return (
      <View style={containerStyle} testID={testID}>
        <Text selectable style={style}>
          {text}
        </Text>
      </View>
    );
  }

  return (
    <View style={containerStyle} testID={testID}>
      <Text selectable style={style}>
        {displayText}
      </Text>
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
    marginTop: 6,
    alignSelf: "flex-start",
    paddingVertical: 2,
    paddingHorizontal: 4,
    borderRadius: 4,
    backgroundColor: theme.colors.surface2,
  },
  toggleLabel: {
    fontSize: 12,
    fontWeight: "500",
    color: theme.colors.foregroundMuted,
  },
}));
