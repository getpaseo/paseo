import { Server } from "lucide-react-native";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

const ThemedServer = withUnistyles(Server, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

/**
 * The always-on divider that names the host a run of sidebar rows lives on.
 *
 * It is not a control: host sections are structural, so there is nothing to collapse and no menu
 * to hang off the label. The label comes from the host profile, so it matches the host switcher
 * and the row badges without a second source of truth.
 */
export function SidebarHostSectionHeader({ label, testID }: { label: string; testID?: string }) {
  return (
    <View style={styles.row} testID={testID}>
      <ThemedServer size={14} strokeWidth={2.2} />
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 32,
    marginTop: theme.spacing[1],
    marginBottom: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    minWidth: 0,
    flexShrink: 1,
  },
}));
