import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { RotateCw } from "lucide-react-native";
import { DesktopPermissionRow } from "@/desktop/components/desktop-permission-row";
import { useDesktopPermissions } from "@/desktop/permissions/use-desktop-permissions";

export function DesktopPermissionsSection() {
  const { theme } = useUnistyles();
  const {
    isDesktop,
    snapshot,
    isRefreshing,
    requestingPermission,
    refreshPermissions,
    requestPermission,
  } = useDesktopPermissions();

  if (!isDesktop) {
    return null;
  }

  const isBusy = isRefreshing || requestingPermission !== null;

  return (
    <View style={styles.section}>
      <View style={styles.permissionSectionHeader}>
        <Text style={styles.sectionTitle}>Desktop permissions</Text>
        <Pressable
          style={({ pressed }) => [
            styles.permissionRefreshButton,
            isBusy && styles.permissionRefreshButtonDisabled,
            pressed && { opacity: 0.85 },
          ]}
          onPress={() => {
            void refreshPermissions();
          }}
          disabled={isBusy}
          accessibilityRole="button"
          accessibilityLabel="Refresh desktop permissions"
        >
          <RotateCw size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      <View style={styles.audioCard}>
        <DesktopPermissionRow
          title="Notifications"
          status={snapshot?.notifications ?? null}
          isRequesting={requestingPermission === "notifications"}
          onRequest={() => {
            void requestPermission("notifications");
          }}
        />
        <DesktopPermissionRow
          title="Microphone"
          showBorder
          status={snapshot?.microphone ?? null}
          isRequesting={requestingPermission === "microphone"}
          onRequest={() => {
            void requestPermission("microphone");
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    marginBottom: theme.spacing[6],
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    marginBottom: 0,
    marginLeft: theme.spacing[1],
  },
  permissionSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
  permissionRefreshButton: {
    width: 34,
    height: 34,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  permissionRefreshButtonDisabled: {
    opacity: theme.opacity[50],
  },
  audioCard: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
}));
