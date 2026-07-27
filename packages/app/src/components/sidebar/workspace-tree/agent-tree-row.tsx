import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { AgentStatusDot } from "@/components/agent-status-dot";
import { SyncedLoader } from "@/components/synced-loader";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { getProviderIcon } from "@/components/provider-icons";
import { WorkspaceTabIcon } from "@/screens/workspace/workspace-tab-presentation";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSidebarTreeExpansionStore } from "@/stores/sidebar-tree-expansion-store";
import { isNative } from "@/constants/platform";
import { shouldRenderSyncedStatusLoader } from "@/utils/status-loader";
import type { Theme } from "@/styles/theme";
import type { AgentTreeNode } from "./agent-tree";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

const chevronColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface AgentTreeRowProps {
  node: AgentTreeNode;
  depth: number;
  serverId: string;
  workspaceId: string;
  onWorkspacePress?: () => void;
}

function agentExpansionKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export const AgentTreeRow = memo(function AgentTreeRow({
  node,
  depth,
  serverId,
  workspaceId,
  onWorkspacePress,
}: AgentTreeRowProps) {
  const { t } = useTranslation();

  const agentKey = agentExpansionKey(serverId, node.agent.id);
  const expanded = useSidebarTreeExpansionStore((state) => state.expandedAgentKeys.has(agentKey));
  const toggleAgentExpanded = useSidebarTreeExpansionStore((state) => state.toggleAgentExpanded);
  const [hovered, setHovered] = useState(false);

  const hasChildren = node.children.length > 0;
  const label = node.agent.title?.trim() || t("sidebar.tree.untitledAgent");
  const isProvider = node.agent.kind === "provider";

  const handleNavigate = useCallback(() => {
    onWorkspacePress?.();
    if (isProvider) {
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: {
          kind: "provider_subagent",
          parentAgentId: node.agent.parentAgentId ?? "",
          subagentId: node.agent.id,
        },
      });
    } else {
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "agent", agentId: node.agent.id },
      });
    }
  }, [
    isProvider,
    onWorkspacePress,
    serverId,
    workspaceId,
    node.agent.id,
    node.agent.parentAgentId,
  ]);

  const handleToggle = useCallback(() => {
    toggleAgentExpanded(agentKey);
  }, [agentKey, toggleAgentExpanded]);

  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);

  const rowStyle = useMemo(() => [styles.row, hovered && styles.rowHovered], [hovered]);

  const statusBucket = deriveSidebarStateBucket({
    status: node.agent.status,
    requiresAttention: node.agent.requiresAttention,
    attentionReason: node.agent.attentionReason,
    pendingPermissionCount: node.agent.pendingPermissionCount,
  });
  const isRunning = shouldRenderSyncedStatusLoader({ bucket: statusBucket });

  // statusBucket: null — WorkspaceTabIcon always renders the provider icon,
  // never a spinner. The spinner is rendered separately in the status slot.
  const presentation = useMemo(
    () => ({
      key: node.agent.id,
      kind: "agent" as const,
      label,
      subtitle: "",
      tooltip: label,
      modified: false,
      titleState: "ready" as const,
      icon: getProviderIcon(node.agent.provider),
      statusBucket: null,
    }),
    [label, node.agent],
  );

  let chevron: ReactNode;
  let chevronLabel: string | undefined;
  if (hasChildren) {
    if (expanded) {
      chevron = <ThemedChevronDown size={14} uniProps={chevronColorMapping} />;
      chevronLabel = t("sidebar.tree.collapseAgent", { label });
    } else {
      chevron = <ThemedChevronRight size={14} uniProps={chevronColorMapping} />;
      chevronLabel = t("sidebar.tree.expandAgent", { label });
    }
  } else {
    chevron = null;
    chevronLabel = undefined;
  }

  return (
    <View>
      <View
        style={rowStyle}
        onPointerEnter={isNative ? undefined : handlePointerEnter}
        onPointerLeave={isNative ? undefined : handlePointerLeave}
      >
        <Pressable
          onPress={hasChildren ? handleToggle : undefined}
          disabled={!hasChildren}
          accessibilityRole="button"
          accessibilityLabel={chevronLabel}
          style={styles.chevronSlot}
          hitSlop={8}
        >
          {chevron}
        </Pressable>
        <Pressable
          onPress={handleNavigate}
          accessibilityRole="button"
          accessibilityLabel={label}
          style={styles.labelArea}
        >
          <View style={styles.iconSlot}>
            <WorkspaceTabIcon presentation={presentation} size={14} />
          </View>
          <View style={styles.statusSlot}>
            {isRunning ? (
              <SyncedLoader size={12} color={styles.syncedLoader.color} />
            ) : (
              <AgentStatusDot
                status={node.agent.status}
                requiresAttention={node.agent.requiresAttention}
                attentionReason={node.agent.attentionReason}
                pendingPermissionCount={node.agent.pendingPermissionCount}
                showInactive
              />
            )}
          </View>
          <Text style={styles.label} numberOfLines={1}>
            {label}
          </Text>
        </Pressable>
      </View>
      {expanded && hasChildren ? (
        <View style={styles.children}>
          {node.children.map((child) => (
            <AgentTreeRow
              key={child.agent.id}
              node={child}
              depth={depth + 1}
              serverId={serverId}
              workspaceId={workspaceId}
              onWorkspacePress={onWorkspacePress}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[1],
    paddingRight: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    minHeight: 28,
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  chevronSlot: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  labelArea: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[1],
  },
  iconSlot: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  statusSlot: {
    width: 16,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  label: {
    flex: 1,
    minWidth: 0,
    marginLeft: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    opacity: 0.85,
  },
  children: {
    paddingLeft: 20,
  },
  syncedLoader: {
    color: theme.colors.palette.blue[500],
  },
}));
