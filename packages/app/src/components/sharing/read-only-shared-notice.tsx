import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Eye } from "lucide-react-native";

export function ReadOnlySharedNotice() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[styles.wrapper, { paddingBottom: Math.max(insets.bottom, 12) + 12 }]}
    >
      <View style={styles.card}>
        <View style={styles.iconWrap}>
          <Eye size={14} color={theme.colors.foregroundMuted} />
        </View>
        <View style={styles.body}>
          <Text style={styles.title}>View-only session</Text>
          <Text style={styles.hint}>
            You were invited with view access — you can watch the agent but can't send messages
            or interact with tools.
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrapper: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
  },
  card: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  iconWrap: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
    marginTop: 1,
  },
  body: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.4,
  },
}));
