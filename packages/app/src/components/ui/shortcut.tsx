import React, { useMemo, type ReactElement } from "react";
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { formatShortcut, type ShortcutKey } from "@/utils/format-shortcut";
import { getShortcutOs } from "@/utils/shortcut-platform";

function colorWithOpacity(color: string, opacity: number): string {
  const hex = color.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    const r = Number.parseInt(hex[1] + hex[1], 16);
    const g = Number.parseInt(hex[2] + hex[2], 16);
    const b = Number.parseInt(hex[3] + hex[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  }
  return `rgba(255, 255, 255, ${opacity})`;
}

export function Shortcut({
  keys,
  chord,
  style,
  textStyle,
}: {
  keys?: ShortcutKey[];
  chord?: ShortcutKey[][];
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}): ReactElement {
  const displayChord = chord ?? (keys ? [keys] : []);
  const shortcutOs = getShortcutOs();
  const singleCombo = displayChord[0];

  const badgeStyle = useMemo(() => [styles.badge, style], [style]);
  const textCombinedStyle = useMemo(() => [styles.text, textStyle], [textStyle]);
  const sequenceStyle = useMemo(() => [styles.sequence, style], [style]);

  if (!singleCombo) {
    return <View style={style} />;
  }

  if (displayChord.length === 1) {
    return (
      <View style={badgeStyle}>
        <Text style={textCombinedStyle}>{formatShortcut(singleCombo, shortcutOs)}</Text>
      </View>
    );
  }

  return (
    <View style={sequenceStyle}>
      {displayChord.map(function (combo) {
        return (
          <View key={combo.join("+")} style={styles.badge}>
            <Text style={textCombinedStyle}>{formatShortcut(combo, shortcutOs)}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  badge: {
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.md,
    backgroundColor: colorWithOpacity(theme.colors.foreground, 0.05),
    borderWidth: 0,
  },
  sequence: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  text: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: colorWithOpacity(theme.colors.foreground, 0.6),
  },
}));
