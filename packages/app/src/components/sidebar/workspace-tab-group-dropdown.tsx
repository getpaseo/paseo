import { useCallback, useMemo } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronDown, ChevronUp, Files } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { collectAllTabs } from "@/stores/workspace-layout-actions";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import {
  WorkspaceTabPresentationResolver,
  WorkspaceTabIcon,
} from "@/screens/workspace/workspace-tab-presentation";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedFiles = withUnistyles(Files);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

function tabGroupKey(serverId: string, workspaceId: string): string {
  return `${serverId}:${workspaceId}`;
}

function toDescriptor(tab: WorkspaceTab): WorkspaceTabDescriptor {
  return {
    key: tab.tabId,
    tabId: tab.tabId,
    kind: tab.target.kind,
    target: tab.target,
  };
}

const rowStyle = ({
  hovered = false,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) => [
  styles.row,
  hovered && !pressed && styles.rowHovered,
  pressed && styles.rowPressed,
];

/**
 * Collapsible dropdown listing a workspace's open tabs. Rendered only when the
 * workspace has more than one tab. Clicking a tab navigates to that workspace tab.
 * Collapse state is persisted in the sidebar-collapsed-sections store.
 */
export function WorkspaceTabGroupDropdown({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const { t } = useTranslation();
  const workspaceKey = tabGroupKey(serverId, workspaceId);
  const layout = useWorkspaceLayoutStore((state) => state.layoutByWorkspace[workspaceKey] ?? null);
  const tabs = useMemo(() => (layout ? collectAllTabs(layout.root) : []), [layout]);
  const collapsed = useSidebarCollapsedSectionsStore((state) =>
    state.collapsedTabGroupKeys.has(workspaceKey),
  );
  const toggleCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleTabGroupCollapsed,
  );

  const handleToggle = useCallback(() => {
    toggleCollapsed(workspaceKey);
  }, [toggleCollapsed, workspaceKey]);

  if (tabs.length <= 1) {
    return null;
  }

  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole={isWeb ? undefined : "button"}
        onPress={handleToggle}
        style={rowStyle}
        testID={`sidebar-tab-group-${workspaceKey}`}
      >
        {({ hovered, pressed }) => (
          <>
            <View style={styles.iconSlot}>
              {collapsed ? (
                <ThemedChevronDown
                  size={12}
                  uniProps={
                    hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping
                  }
                />
              ) : (
                <ThemedChevronUp
                  size={12}
                  uniProps={
                    hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping
                  }
                />
              )}
            </View>
            <ThemedFiles
              size={14}
              uniProps={hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping}
            />
            <Text numberOfLines={1} style={styles.headerText}>
              {t("sidebar.workspace.actions.tabs", { count: tabs.length })}
            </Text>
          </>
        )}
      </Pressable>
      {collapsed ? null : (
        <View>
          {tabs.map((tab) => (
            <TabRow
              key={tab.tabId}
              tab={toDescriptor(tab)}
              serverId={serverId}
              workspaceId={workspaceId}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function TabRow({
  tab,
  serverId,
  workspaceId,
}: {
  tab: WorkspaceTabDescriptor;
  serverId: string;
  workspaceId: string;
}) {
  const handlePress = useCallback(() => {
    navigateToWorkspace({
      serverId,
      workspaceId,
      target: tab.target,
    });
  }, [serverId, tab.target, workspaceId]);

  return (
    <WorkspaceTabPresentationResolver tab={tab} serverId={serverId} workspaceId={workspaceId}>
      {(presentation) => (
        <Pressable
          accessibilityRole={isWeb ? undefined : "button"}
          onPress={handlePress}
          style={rowStyle}
          testID={`sidebar-tab-row-${tab.tabId}`}
        >
          {() => (
            <>
              <View style={styles.tabIconSlot}>
                <WorkspaceTabIcon presentation={presentation} size={12} backdrop="surface0" />
              </View>
              <Text numberOfLines={1} style={styles.tabText}>
                {presentation.label}
              </Text>
            </>
          )}
        </Pressable>
      )}
    </WorkspaceTabPresentationResolver>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingLeft: 16,
    paddingRight: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 4,
    borderRadius: 4,
    marginRight: 8,
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  iconSlot: {
    width: 12,
    alignItems: "center",
  },
  tabIconSlot: {
    width: 16,
    alignItems: "center",
  },
  headerText: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: 12,
  },
  tabText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: 12,
  },
}));
