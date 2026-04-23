import { useMemo, type ReactElement } from "react";
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { formatShortcut, type ShortcutKey } from "@/utils/format-shortcut";
import { getShortcutOs } from "@/utils/shortcut-platform";

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
      {displayChord.map(function (combo, index) {
        return (
          <View key={`${combo.join("+")}-${index}`} style={styles.badge}>
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
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
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
    color: theme.colors.foregroundMuted,
  },
}));
