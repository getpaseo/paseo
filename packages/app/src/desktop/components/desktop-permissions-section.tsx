import { View, Text } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { RotateCw } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { DesktopPermissionRow } from "@/desktop/components/desktop-permission-row";
import { useDesktopPermissions } from "@/desktop/permissions/use-desktop-permissions";
import { settingsStyles } from "@/styles/settings";

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
    <View style={settingsStyles.section}>
      <View style={styles.permissionSectionHeader}>
        <Text style={settingsStyles.sectionTitle}>Desktop Permissions</Text>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<RotateCw size={theme.iconSize.md} color={theme.colors.foregroundMuted} />}
          onPress={() => {
            void refreshPermissions();
          }}
          disabled={isBusy}
          accessibilityLabel="Refresh desktop permissions"
        >
          {isRefreshing ? "Refreshing..." : "Refresh"}
        </Button>
      </View>
      <View style={settingsStyles.card}>
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
  permissionSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
}));
