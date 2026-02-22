import { View, Text } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Check } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import type { DesktopPermissionStatus } from "@/desktop/permissions/desktop-permissions";

export interface DesktopPermissionRowProps {
  title: string;
  status: DesktopPermissionStatus | null;
  isRequesting: boolean;
  showBorder?: boolean;
  onRequest: () => void;
}

export function DesktopPermissionRow({
  title,
  status,
  isRequesting,
  showBorder,
  onRequest,
}: DesktopPermissionRowProps) {
  const { theme } = useUnistyles();
  const state = status?.state ?? "unknown";
  const isGranted = state === "granted";
  const shouldShowDetail =
    status !== null &&
    status.detail.trim().length > 0 &&
    state !== "granted" &&
    state !== "prompt" &&
    state !== "not-granted";

  return (
    <View style={[styles.audioRow, showBorder && styles.audioRowBorder]}>
      <View style={styles.audioRowContent}>
        <Text style={styles.audioRowTitle}>{title}</Text>
      </View>
      <View style={styles.permissionRowActions}>
        {isGranted ? (
          <View style={styles.permissionStatusPill}>
            <Check size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            <Text style={styles.permissionStatusText}>Granted</Text>
          </View>
        ) : (
          <Button variant="secondary" size="sm" onPress={onRequest} disabled={isRequesting}>
            {isRequesting ? "Requesting..." : "Request"}
          </Button>
        )}
        {shouldShowDetail ? <Text style={styles.permissionDetailText}>{status?.detail}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  audioRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  audioRowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  audioRowContent: {
    flex: 1,
    marginRight: theme.spacing[3],
  },
  audioRowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  permissionRowActions: {
    alignItems: "flex-end",
    gap: theme.spacing[1],
  },
  permissionStatusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface3,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 4,
    minWidth: 88,
    justifyContent: "center",
  },
  permissionStatusText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  permissionDetailText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    maxWidth: 220,
    textAlign: "right",
  },
}));
