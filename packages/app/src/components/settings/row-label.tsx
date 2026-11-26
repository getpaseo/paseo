import { useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSettingsRowLayout } from "./row-density";

/**
 * A row's label line: the label, and beside it an accessory such as a badge or an info tip. Rows
 * with inline controls and rows that lead somewhere both draw it, so their labels and hints keep
 * the same distances whether or not a row carries an accessory.
 */
export function SettingsRowTitle({ label, accessory }: { label: string; accessory?: ReactNode }) {
  const layout = useSettingsRowLayout();
  const titleStyle = useMemo(() => [layout.title, styles.title], [layout]);
  if (!accessory) return <Text style={layout.title}>{label}</Text>;
  return (
    <View style={styles.line}>
      <Text style={titleStyle}>{label}</Text>
      <View style={styles.accessory}>{accessory}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  line: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: { flexShrink: 1, minWidth: 0 },
  // An accessory is taller than the label's line. It hangs into the row's padding instead, so the
  // label and hint keep the distances of a row without one.
  accessory: { marginVertical: -theme.spacing[1] },
}));
