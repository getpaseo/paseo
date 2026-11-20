import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/**
 * The reset data of a window or balance: the countdown first, then the exact time. When the line
 * is too narrow the exact time truncates and the countdown wraps within its column.
 */
export function UsageResetLine({
  countdown,
  exactTime,
  testID,
}: {
  countdown: string | null;
  exactTime: string | null;
  testID?: string;
}) {
  if (!countdown) return null;
  return (
    <View style={styles.line} testID={testID}>
      <Text style={[styles.text, styles.countdown]}>{countdown}</Text>
      {exactTime ? (
        <Text style={[styles.text, styles.exactTime]} numberOfLines={1} ellipsizeMode="tail">
          {`\u00a0·\u00a0${exactTime}`}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  line: { flexDirection: "row", alignItems: "baseline" },
  text: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  countdown: { maxWidth: "100%" },
  exactTime: { flexShrink: 1, minWidth: 0 },
}));
