import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import { StatusBadge } from "@/components/ui/status-badge";
import type { ActiveConnection } from "@/runtime/host-runtime";
import { useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { openServiceUrl } from "@/utils/open-service-url";
import { resolveWorkspaceScriptLink } from "@/utils/workspace-script-links";

export interface ExplorerPortsPaneProps {
  serverId: string;
  workspaceId?: string | null;
  onOpenUrlInBrowserTab?: (url: string) => void;
}

interface PortRow {
  key: string;
  scriptName: string;
  port: number | null;
  protocol: "HTTP" | "TCP";
  lifecycle: WorkspaceScriptPayload["lifecycle"];
  openUrl: string | null;
}

const EMPTY_SCRIPTS: WorkspaceScriptPayload[] = [];

function buildPortRows(input: {
  scripts: readonly WorkspaceScriptPayload[];
  activeConnection: ActiveConnection | null;
}): PortRow[] {
  const rows: PortRow[] = [];
  for (const script of input.scripts) {
    const hasPort = script.port != null;
    if (!hasPort && script.type !== "service") {
      continue;
    }
    const link = resolveWorkspaceScriptLink({
      script,
      activeConnection: input.activeConnection,
    });
    rows.push({
      key: `${script.scriptName}:${script.port ?? "none"}`,
      scriptName: script.scriptName,
      port: script.port,
      protocol: script.type === "service" ? "HTTP" : "TCP",
      lifecycle: script.lifecycle,
      openUrl: link.primary?.url ?? null,
    });
  }
  return rows.sort((a, b) => {
    if (a.lifecycle !== b.lifecycle) {
      return a.lifecycle === "running" ? -1 : 1;
    }
    return a.scriptName.localeCompare(b.scriptName);
  });
}

export function ExplorerPortsPane({
  serverId,
  workspaceId,
  onOpenUrlInBrowserTab,
}: ExplorerPortsPaneProps): ReactElement {
  const { t } = useTranslation();
  const scripts = useSessionStore((state) => {
    if (!workspaceId) {
      return EMPTY_SCRIPTS;
    }
    return state.sessions[serverId]?.workspaces?.get(workspaceId)?.scripts ?? EMPTY_SCRIPTS;
  });
  const activeConnection = useHostRuntimeSnapshot(serverId)?.activeConnection ?? null;
  const rows = useMemo(
    () => buildPortRows({ scripts, activeConnection }),
    [activeConnection, scripts],
  );

  const handleOpen = useCallback(
    (row: PortRow) => {
      if (!row.openUrl) {
        return;
      }
      void openServiceUrl(row.openUrl, { openInApp: onOpenUrlInBrowserTab });
    },
    [onOpenUrlInBrowserTab],
  );

  if (rows.length === 0) {
    return (
      <View style={styles.empty} testID="explorer-ports-empty">
        <Text style={styles.emptyText}>{t("workspace.tabs.explorer.portsEmpty")}</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      testID="explorer-ports-list"
    >
      {rows.map((row) => (
        <ExplorerPortRow key={row.key} row={row} onOpen={handleOpen} />
      ))}
    </ScrollView>
  );
}

function ExplorerPortRow({
  row,
  onOpen,
}: {
  row: PortRow;
  onOpen: (row: PortRow) => void;
}): ReactElement {
  const { t } = useTranslation();
  const canOpen = Boolean(row.openUrl);
  const handlePress = useCallback(() => {
    onOpen(row);
  }, [onOpen, row]);
  const rowStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => [
      styles.row,
      (hovered || pressed) && canOpen ? styles.rowActive : null,
    ],
    [canOpen],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("workspace.tabs.explorer.portRowA11y", {
        name: row.scriptName,
        protocol: row.protocol,
        port: row.port ?? "—",
      })}
      disabled={!canOpen}
      onPress={handlePress}
      style={rowStyle}
      testID={`explorer-port-row-${row.scriptName}`}
    >
      <StatusBadge
        label={row.protocol}
        variant={row.lifecycle === "running" ? "success" : "muted"}
      />
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {row.scriptName}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {row.port != null
            ? t("workspace.tabs.explorer.portMeta", {
                port: row.port,
                status: row.lifecycle,
              })
            : row.lifecycle}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingVertical: theme.spacing[1],
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[4],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  rowActive: {
    backgroundColor: theme.colors.surface2,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  rowMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
