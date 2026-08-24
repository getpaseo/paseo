import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceServicePayload } from "@getpaseo/protocol/messages";
import { Eye, Play, RotateCw, SquareTerminal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { confirmDialog } from "@/utils/confirm-dialog";
import { openServiceUrl } from "@/utils/open-service-url";
import { useToast } from "@/contexts/toast-context";

const ThemedEye = withUnistyles(Eye);
const ThemedPlay = withUnistyles(Play);
const ThemedRefresh = withUnistyles(RotateCw);
const ThemedTerminal = withUnistyles(SquareTerminal);
const iconColor = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

interface WorkspaceServiceCandidatesProps {
  client: DaemonClient | null;
  workspaceDirectory: string | null;
  services: WorkspaceServicePayload[];
  error: string | null;
  onRefresh: () => Promise<void>;
  onTerminalStarted?: (terminalId: string) => void;
  onViewTerminal?: (terminalId: string) => void;
  onOpenUrlInBrowserTab?: (url: string) => void;
}

function lifecycleLabel(service: WorkspaceServicePayload): string {
  if (service.port) return `${service.lifecycle} · :${service.port}`;
  return service.lifecycle;
}

function CandidateRow({
  service,
  onOpen,
  onStart,
  onViewTerminal,
}: {
  service: WorkspaceServicePayload;
  onOpen: (service: WorkspaceServicePayload) => void;
  onStart: (service: WorkspaceServicePayload) => Promise<void>;
  onViewTerminal?: (terminalId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleOpen = useCallback(() => onOpen(service), [onOpen, service]);
  const handleStart = useCallback(() => void onStart(service), [onStart, service]);
  const handleViewTerminal = useCallback(() => {
    if (service.terminalId) onViewTerminal?.(service.terminalId);
  }, [onViewTerminal, service.terminalId]);

  return (
    <View style={styles.row} testID={`workspace-service-${service.id}`}>
      <ThemedTerminal size={14} uniProps={iconColor} />
      <View style={styles.identity}>
        <Text style={styles.name} numberOfLines={1}>
          {service.label}
        </Text>
        <Text style={styles.detail} numberOfLines={1}>
          {service.source === "package" ? service.command : lifecycleLabel(service)}
        </Text>
      </View>
      {service.localUrl || service.publicUrl ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("workspace.services.open", { name: service.label })}
          onPress={handleOpen}
          style={styles.iconButton}
        >
          <ThemedEye size={13} uniProps={iconColor} />
        </Pressable>
      ) : null}
      {service.terminalId ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("workspace.services.logs", { name: service.label })}
          onPress={handleViewTerminal}
          style={styles.iconButton}
        >
          <ThemedTerminal size={13} uniProps={iconColor} />
        </Pressable>
      ) : null}
      {service.source === "package" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("workspace.services.startNamed", { name: service.label })}
          onPress={handleStart}
          style={styles.iconButton}
        >
          <ThemedPlay size={13} uniProps={iconColor} />
        </Pressable>
      ) : null}
    </View>
  );
}

export function WorkspaceServiceCandidates({
  client,
  workspaceDirectory,
  services,
  error,
  onRefresh,
  onTerminalStarted,
  onViewTerminal,
  onOpenUrlInBrowserTab,
}: WorkspaceServiceCandidatesProps): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const supplementary = useMemo(
    () => services.filter((service) => service.source !== "configured"),
    [services],
  );

  const startPackageService = useCallback(
    async (service: WorkspaceServicePayload) => {
      if (!client || !workspaceDirectory || !service.command) return;
      const confirmed = await confirmDialog({
        title: t("workspace.services.confirmStartTitle", { name: service.label }),
        message: t("workspace.services.confirmStartMessage", { command: service.command }),
        confirmLabel: t("workspace.services.start"),
        cancelLabel: t("common.actions.cancel"),
      });
      if (!confirmed) return;
      const [command, ...args] = service.command.split(" ");
      if (!command) return;
      const result = await client.createTerminal(workspaceDirectory, service.label, undefined, {
        command,
        args,
        workspaceId: service.workspaceId,
      });
      if (!result.terminal) {
        toast.show(result.error ?? t("workspace.services.startFailed"), { variant: "error" });
        return;
      }
      onTerminalStarted?.(result.terminal.id);
    },
    [client, onTerminalStarted, t, toast, workspaceDirectory],
  );

  const openService = useCallback(
    (service: WorkspaceServicePayload) => {
      const url = service.publicUrl ?? service.localUrl;
      if (url) void openServiceUrl(url, { openInApp: onOpenUrlInBrowserTab });
    },
    [onOpenUrlInBrowserTab],
  );
  const handleRefresh = useCallback(() => void onRefresh(), [onRefresh]);

  if (supplementary.length === 0 && !error) return null;
  return (
    <View style={styles.section} testID="workspace-services-detected">
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{t("workspace.services.detected")}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("workspace.services.refresh")}
          onPress={handleRefresh}
          style={styles.iconButton}
        >
          <ThemedRefresh size={12} uniProps={iconColor} />
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {supplementary.map((service) => (
        <CandidateRow
          key={service.id}
          service={service}
          onOpen={openService}
          onStart={startPackageService}
          onViewTerminal={onViewTerminal}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing[2] },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  sectionTitle: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  identity: { flex: 1, minWidth: 0 },
  name: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  iconButton: {
    width: theme.spacing[6],
    height: theme.spacing[6],
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  error: { color: theme.colors.palette.red[500], fontSize: theme.fontSize.sm },
}));
