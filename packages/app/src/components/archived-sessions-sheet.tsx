import { useCallback, useMemo, useState } from "react";
import { Pressable, type PressableStateCallbackType, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { Inbox } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { getProviderIcon } from "@/components/provider-icons";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { agentHistoryQueryKey } from "@/hooks/agent-history-query-key";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useAgentHistory } from "@/hooks/use-agent-history";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";
import { formatTimeAgo } from "@/utils/time";

const ARCHIVED_SHEET_SNAP_POINTS = ["70%", "92%"];
const DISABLED_ACCESSIBILITY_STATE = { disabled: true };

interface ArchivedSessionsSheetProps {
  visible: boolean;
  serverId: string;
  cwd: string | null;
  onClose: () => void;
  onUnarchivedAgent?: (agentId: string) => void;
}

export function selectArchivedAgentsForCwd(
  agents: ReadonlyArray<AggregatedAgent>,
  cwd: string | null | undefined,
): AggregatedAgent[] {
  const normalizedCwd = normalizeWorkspacePath(cwd);
  if (!normalizedCwd) {
    return [];
  }
  return agents
    .filter((agent) => agent.archivedAt != null)
    .filter((agent) => normalizeWorkspacePath(agent.cwd) === normalizedCwd)
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
}

function getRowTitle(agent: AggregatedAgent): string {
  const title = agent.title?.trim();
  if (title) {
    return title;
  }
  return "Untitled session";
}

interface ArchivedSessionRowProps {
  agent: AggregatedAgent;
  disabled: boolean;
  pending: boolean;
  onPress: (agent: AggregatedAgent) => void;
}

function ArchivedSessionRow({ agent, disabled, pending, onPress }: ArchivedSessionRowProps) {
  const { theme } = useUnistyles();
  const ProviderIcon = getProviderIcon(agent.provider);
  const title = getRowTitle(agent);
  const lastActivity = formatTimeAgo(new Date(agent.lastActivityAt));
  const accessibilityState = useMemo(
    () => (disabled ? DISABLED_ACCESSIBILITY_STATE : undefined),
    [disabled],
  );
  const handlePress = useCallback(() => {
    onPress(agent);
  }, [agent, onPress]);
  const pressableStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      Boolean(hovered) && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [],
  );

  return (
    <Pressable
      disabled={disabled}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      style={pressableStyle}
      testID={`archived-session-${agent.id}`}
    >
      <View style={styles.rowIconWrap}>
        <ProviderIcon size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
      </View>
      <View style={styles.rowContent}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.rowMeta}>{pending ? "Restoring..." : lastActivity}</Text>
        </View>
        {agent.cwd ? (
          <Text style={styles.rowCwd} numberOfLines={1}>
            {agent.cwd}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export function ArchivedSessionsSheet({
  visible,
  serverId,
  cwd,
  onClose,
  onUnarchivedAgent,
}: ArchivedSessionsSheetProps) {
  const { theme } = useUnistyles();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const queryClient = useQueryClient();
  const { agents, isInitialLoad, isRevalidating } = useAgentHistory({
    serverId,
    enabled: visible,
  });

  const archivedAgents = useMemo(() => selectArchivedAgentsForCwd(agents, cwd), [agents, cwd]);

  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null);
  const [errorAgentId, setErrorAgentId] = useState<string | null>(null);

  const handleRestore = useCallback(
    async (agent: AggregatedAgent) => {
      if (!client || !isConnected || pendingAgentId) {
        return;
      }
      setPendingAgentId(agent.id);
      setErrorAgentId(null);
      try {
        await client.refreshAgent(agent.id);
        void queryClient.invalidateQueries({ queryKey: agentHistoryQueryKey(serverId) });
        onUnarchivedAgent?.(agent.id);
        onClose();
      } catch (error) {
        console.error("[ArchivedSessionsSheet] Failed to restore agent:", error);
        setErrorAgentId(agent.id);
      } finally {
        setPendingAgentId(null);
      }
    },
    [client, isConnected, onClose, onUnarchivedAgent, pendingAgentId, queryClient, serverId],
  );

  const header = useMemo<SheetHeader>(() => ({ title: "Archived sessions" }), []);

  const isEmpty = !isInitialLoad && archivedAgents.length === 0;
  const isClientReady = Boolean(client && isConnected);
  const showLoadingRow = visible && isInitialLoad && isClientReady;
  const showRevalidatingHint = visible && isRevalidating && !isInitialLoad;

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      testID="archived-sessions-sheet"
      desktopMaxWidth={560}
      snapPoints={ARCHIVED_SHEET_SNAP_POINTS}
    >
      {!isClientReady ? (
        <Text style={styles.statusText}>Connect to a host to view archived sessions</Text>
      ) : null}
      {showLoadingRow ? (
        <View style={styles.statusRow}>
          <LoadingSpinner color={theme.colors.foregroundMuted} />
          <Text style={styles.statusText}>Loading archived sessions...</Text>
        </View>
      ) : null}
      {showRevalidatingHint ? <Text style={styles.statusText}>Refreshing...</Text> : null}
      {errorAgentId ? (
        <Text style={styles.statusText}>Could not restore the selected session.</Text>
      ) : null}
      {archivedAgents.length > 0 ? (
        <View style={styles.list}>
          {archivedAgents.map((agent) => (
            <ArchivedSessionRow
              key={agent.id}
              agent={agent}
              disabled={pendingAgentId != null}
              pending={pendingAgentId === agent.id}
              onPress={handleRestore}
            />
          ))}
        </View>
      ) : null}
      {isEmpty && isClientReady ? (
        <View style={styles.emptyState} testID="archived-sessions-empty-state">
          <View style={styles.emptyStateIcon}>
            <Inbox
              size={theme.iconSize.lg}
              color={theme.colors.foregroundMuted}
              strokeWidth={1.5}
            />
          </View>
          <Text style={styles.emptyStateTitle}>No archived sessions in this workspace.</Text>
        </View>
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    marginHorizontal: -theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  rowIconWrap: {
    width: theme.iconSize.md,
    paddingTop: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  rowTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  rowMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  rowCwd: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[8],
    paddingHorizontal: theme.spacing[4],
  },
  emptyStateIcon: {
    opacity: 0.6,
    marginBottom: theme.spacing[1],
  },
  emptyStateTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
