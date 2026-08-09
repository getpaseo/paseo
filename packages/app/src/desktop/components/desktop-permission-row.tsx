import { useMemo } from "react";
import { View, Text } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import type { DesktopPermissionStatus } from "@/desktop/permissions/desktop-permissions";

export interface DesktopPermissionRowProps {
  title: string;
  status: DesktopPermissionStatus | null;
  isRequesting: boolean;
  labels: {
    granted: string;
    request: string;
    requesting: string;
  };
  showBorder?: boolean;
  onRequest: () => void;
}

const ThemedCheck = withUnistyles(Check, (theme) => ({
  size: theme.iconSize.sm,
  color: theme.colors.foregroundMuted,
}));

export function DesktopPermissionRow({
  title,
  status,
  isRequesting,
  labels,
  showBorder,
  onRequest,
}: DesktopPermissionRowProps) {
  const state = status?.state ?? "unknown";
  const isGranted = state === "granted";
  const shouldShowDetail =
    status !== null &&
    status.detail.trim().length > 0 &&
    state !== "granted" &&
    state !== "prompt" &&
    state !== "not-granted";

  const rowStyle = useMemo(
    () => [settingsStyles.row, showBorder && settingsStyles.rowBorder],
    [showBorder],
  );

  return (
    <View style={rowStyle}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
      </View>
      <View style={styles.permissionRowActions}>
        {isGranted ? (
          <View style={styles.permissionStatusPill}>
            <ThemedCheck />
            <Text style={styles.permissionStatusText}>{labels.granted}</Text>
          </View>
        ) : (
          <Button variant="outline" size="sm" onPress={onRequest} disabled={isRequesting}>
            {isRequesting ? labels.requesting : labels.request}
          </Button>
        )}
        {shouldShowDetail ? (
          <Text style={styles.permissionDetailText}>{status?.detail}</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
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
    color: theme.colors.foregroundMuted,
  },
  permissionDetailText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    maxWidth: 220,
    textAlign: "right",
  },
}));
