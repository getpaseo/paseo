import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/**
 * The reset data of a window or balance: the countdown first, then the exact time. When the line
 * is too narrow the exact time gives way (truncates) and the countdown stays whole.
 */
export function UsageResetLine({
  countdown,
  exactTime,
  atRisk = false,
  testID,
}: {
  countdown: string | null;
  exactTime: string | null;
  /** The countdown is a runs-out warning rather than a reset. */
  atRisk?: boolean;
  testID?: string;
}) {
  if (!countdown) return null;
  return (
    <View style={styles.line} testID={testID}>
      <Text style={atRisk ? styles.atRisk : styles.text}>{countdown}</Text>
      {exactTime ? (
        <Text style={[styles.text, styles.exactTime]} numberOfLines={1} ellipsizeMode="tail">
          {`\u00a0·\u00a0${exactTime}`}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  line: { flexDirection: "row", alignItems: "center" },
  text: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  atRisk: {
    flexShrink: 0,
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  exactTime: { flexShrink: 1 },
}));
