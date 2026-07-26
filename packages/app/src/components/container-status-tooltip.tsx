import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { WorkspaceDescriptor } from "@/stores/session-store";

export type ContainerStatus = NonNullable<WorkspaceDescriptor["containerStatus"]>;
export type ContainerInfo = NonNullable<WorkspaceDescriptor["containerInfo"]>;

/**
 * What the container badge and the sidebar's container icon say when pointed
 * at. Both describe the same container, so they share one body: which backend
 * runs it, which image it came from, and who it runs as — the facts you need to
 * tell one workspace's environment from another's.
 *
 * Falls back to a description of the status when the daemon has no details yet
 * (the container is still starting, or it predates this daemon).
 */
export function ContainerStatusTooltipBody({
  containerStatus,
  containerInfo,
}: {
  containerStatus: ContainerStatus;
  containerInfo: ContainerInfo | null | undefined;
}) {
  const { t } = useTranslation();

  if (!containerInfo) {
    return (
      <Text style={styles.text}>{t(`workspace.header.container.${containerStatus}Tooltip`)}</Text>
    );
  }

  const rows: Array<{ label: string; value: string }> = [
    {
      label: t("workspace.header.container.details.backend"),
      // Older daemons only send the backend id.
      value: containerInfo.backendLabel ?? containerInfo.backend,
    },
    { label: t("workspace.header.container.details.image"), value: containerInfo.image },
    {
      label: t("workspace.header.container.details.container"),
      value: containerInfo.containerName,
    },
    { label: t("workspace.header.container.details.user"), value: containerInfo.remoteUser },
    {
      label: t("workspace.header.container.details.started"),
      value: new Date(containerInfo.startedAt).toLocaleString(),
    },
  ];

  return (
    <View style={styles.content}>
      <Text style={styles.title}>{t(`workspace.header.container.${containerStatus}`)}</Text>
      <View style={styles.grid}>
        {rows.map((row) => (
          <View key={row.label} style={styles.row}>
            <Text style={styles.label}>{row.label}</Text>
            <Text style={styles.value} numberOfLines={1}>
              {row.value}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: {
    gap: theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.popoverForeground,
  },
  grid: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  label: {
    minWidth: 68,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontWeight: "500",
  },
  value: {
    flexShrink: 1,
    fontSize: theme.fontSize.xs,
    color: theme.colors.popoverForeground,
  },
  text: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
}));
