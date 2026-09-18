import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, type PressableStateCallbackType, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight, Plus } from "lucide-react-native";
import { router, type Href } from "expo-router";
import type { Theme } from "@/styles/theme";
import type { HostBadgeModel } from "@/hosts/appearance";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { ToggleSidebarWorkspacePin } from "@/hooks/use-sidebar-workspace-pin";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useHosts } from "@/runtime/host-runtime";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isChatWorkspace } from "./model";

const ThemedPlus = withUnistyles(Plus);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export interface SidebarChatsSectionProps {
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  pinnedWorkspaceKeys?: ReadonlySet<string>;
  supportsChatByServerId?: ReadonlyMap<string, boolean>;
  onWorkspacePress?: () => void;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
  creatingWorkspaceIds: ReadonlySet<string>;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  showShortcutBadges: boolean;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  selectionEnabled: boolean;
  renderWorkspaceItem: (entry: SidebarWorkspaceEntry) => React.ReactNode;
}

export const SidebarChatsSection = memo(function SidebarChatsSection({
  workspaceEntriesByKey,
  pinnedWorkspaceKeys,
  supportsChatByServerId,
  onWorkspacePress,
  creatingWorkspaceIds: _creatingWorkspaceIds,
  hostBadgeByServerId: _hostBadgeByServerId,
  supportsPinningByServerId: _supportsPinningByServerId,
  onToggleWorkspacePin: _onToggleWorkspacePin,
  showShortcutBadges: _showShortcutBadges,
  shortcutIndexByWorkspaceKey: _shortcutIndexByWorkspaceKey,
  selectionEnabled: _selectionEnabled,
  renderWorkspaceItem,
}: SidebarChatsSectionProps) {
  const allHosts = useHosts();
  const activeSelection = useActiveWorkspaceSelection();
  const [collapsed, setCollapsed] = useState(false);

  const chatEntries = useMemo(() => {
    return Array.from(workspaceEntriesByKey.values()).filter(
      (workspace) =>
        !pinnedWorkspaceKeys?.has(workspace.workspaceKey) && isChatWorkspace(workspace),
    );
  }, [pinnedWorkspaceKeys, workspaceEntriesByKey]);

  const anyHostSupportsChat = useMemo(() => {
    if (!supportsChatByServerId || supportsChatByServerId.size === 0) return true;
    for (const supports of supportsChatByServerId.values()) {
      if (supports) return true;
    }
    return false;
  }, [supportsChatByServerId]);

  const targetServerId = activeSelection?.serverId ?? allHosts[0]?.serverId;
  const targetHostSupportsChat = Boolean(
    targetServerId &&
    (supportsChatByServerId ? supportsChatByServerId.get(targetServerId) === true : true),
  );

  const handleCreateChat = useCallback(() => {
    const targetId = activeSelection?.serverId ?? allHosts[0]?.serverId;
    onWorkspacePress?.();
    router.navigate(
      buildNewWorkspaceRoute({
        serverId: targetId,
        kind: "chat",
      }) as Href,
    );
  }, [activeSelection, allHosts, onWorkspacePress]);

  const toggleCollapsed = useCallback(() => setCollapsed((prev) => !prev), []);

  const newChatButtonStyle = useCallback(
    ({ hovered = false, pressed = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.chatsNewButton,
      hovered && styles.chatsNewButtonHovered,
      pressed && styles.chatsNewButtonPressed,
    ],
    [],
  );

  const emptyChatRow = targetHostSupportsChat ? (
    <SidebarHeaderRow
      icon={Plus}
      label="New chat"
      onPress={handleCreateChat}
      testID="sidebar-chats-empty-start"
      variant="compact"
      containerStyle={styles.chatsEmptyContainer}
    />
  ) : null;

  if (chatEntries.length === 0 && !anyHostSupportsChat) {
    return null;
  }

  return (
    <View style={styles.chatsSectionContainer} testID="sidebar-chats-section">
      <View style={styles.chatsSectionDivider} />
      <View style={styles.chatsSectionHeader}>
        <Pressable
          onPress={toggleCollapsed}
          style={styles.chatsSectionHeaderLeft}
          accessibilityRole="button"
          accessibilityLabel="Toggle chats"
        >
          <Text style={styles.chatsSectionTitle}>Chats</Text>
          {collapsed ? (
            <ThemedChevronRight size={12} uniProps={foregroundMutedColorMapping} />
          ) : (
            <ThemedChevronDown size={12} uniProps={foregroundMutedColorMapping} />
          )}
        </Pressable>
        <View style={styles.chatsSectionHeaderRight}>
          {targetHostSupportsChat && (
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Pressable
                  onPress={handleCreateChat}
                  hitSlop={4}
                  style={newChatButtonStyle}
                  testID="sidebar-chats-new-button"
                  accessibilityRole="button"
                  accessibilityLabel="New chat"
                >
                  <ThemedPlus size={14} uniProps={foregroundMutedColorMapping} />
                </Pressable>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center" offset={8}>
                <Text style={styles.projectActionTooltipText}>New chat</Text>
              </TooltipContent>
            </Tooltip>
          )}
        </View>
      </View>
      {!collapsed && (
        <View style={styles.chatsSectionBody}>
          {chatEntries.length === 0
            ? emptyChatRow
            : chatEntries.map((entry) => renderWorkspaceItem(entry))}
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  chatsSectionDivider: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing[2],
    marginHorizontal: theme.spacing[3],
  },
  chatsSectionContainer: {
    marginBottom: theme.spacing[2],
  },
  chatsSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  chatsSectionHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  chatsSectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  chatsSectionHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  chatsNewButton: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
  },
  chatsNewButtonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  chatsNewButtonPressed: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  chatsSectionBody: {
    paddingTop: theme.spacing[1],
    gap: 2,
  },
  chatsEmptyContainer: {
    paddingHorizontal: 0,
  },
  projectActionTooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
}));
