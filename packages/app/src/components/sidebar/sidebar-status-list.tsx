import { memo, useCallback, useMemo, useState } from "react";
import { View, Text, Pressable, ScrollView, type PressableStateCallbackType } from "react-native";
import { NestableScrollContainer } from "react-native-draggable-flatlist";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import {
  buildStatusGroups,
  buildStatusShortcutIndex,
  type StatusGroup,
} from "@/hooks/sidebar-status-view-model";
import { isWeb as platformIsWeb, isNative as platformIsNative } from "@/constants/platform";
import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { withUnistyles } from "react-native-unistyles";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleX,
} from "lucide-react-native";
import { useSidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { SidebarWorkspaceRow } from "@/components/sidebar/sidebar-workspace-row";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";

// Themed icon wrappers
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const blueColorMapping = (theme: Theme) => ({ color: theme.colors.palette.blue[500] });
const amberColorMapping = (theme: Theme) => ({ color: theme.colors.palette.amber[500] });
const redColorMapping = (theme: Theme) => ({ color: theme.colors.palette.red[500] });
const greenColorMapping = (theme: Theme) => ({ color: theme.colors.palette.green[500] });

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCircleX = withUnistyles(CircleX);

interface StatusWorkspaceListProps {
  workspaces: SidebarWorkspaceEntry[];
  projectNamesByKey: Map<string, string>;
  serverId: string | null;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  showShortcutBadges: boolean;
  onWorkspacePress?: () => void;
}

export function SidebarStatusWorkspaceList({
  workspaces,
  projectNamesByKey,
  serverId,
  shortcutIndexByWorkspaceKey: _projectShortcutIndex,
  showShortcutBadges,
  onWorkspacePress,
}: StatusWorkspaceListProps) {
  const groups = useMemo(
    () => buildStatusGroups(workspaces, projectNamesByKey),
    [workspaces, projectNamesByKey],
  );
  const collapsedStatusGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedStatusGroupKeys,
  );

  const statusShortcutIndex = useMemo(
    () =>
      showShortcutBadges
        ? buildStatusShortcutIndex(
            groups.filter((group) => !collapsedStatusGroupKeys.has(group.bucket)),
          )
        : new Map<string, number>(),
    [collapsedStatusGroupKeys, groups, showShortcutBadges],
  );

  return (
    <View style={styles.container}>
      {platformIsNative ? (
        <NestableScrollContainer
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          testID="sidebar-status-list-scroll"
        >
          <StatusGroupList
            groups={groups}
            collapsedStatusGroupKeys={collapsedStatusGroupKeys}
            projectNamesByKey={projectNamesByKey}
            serverId={serverId}
            shortcutIndex={statusShortcutIndex}
            showShortcutBadges={showShortcutBadges}
            onWorkspacePress={onWorkspacePress}
          />
        </NestableScrollContainer>
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          testID="sidebar-status-list-scroll"
        >
          <StatusGroupList
            groups={groups}
            collapsedStatusGroupKeys={collapsedStatusGroupKeys}
            projectNamesByKey={projectNamesByKey}
            serverId={serverId}
            shortcutIndex={statusShortcutIndex}
            showShortcutBadges={showShortcutBadges}
            onWorkspacePress={onWorkspacePress}
          />
        </ScrollView>
      )}
    </View>
  );
}

function StatusGroupList({
  groups,
  collapsedStatusGroupKeys,
  projectNamesByKey,
  serverId,
  shortcutIndex,
  showShortcutBadges,
  onWorkspacePress,
}: {
  groups: StatusGroup[];
  collapsedStatusGroupKeys: ReadonlySet<string>;
  projectNamesByKey: Map<string, string>;
  serverId: string | null;
  shortcutIndex: Map<string, number>;
  showShortcutBadges: boolean;
  onWorkspacePress?: () => void;
}) {
  return (
    <>
      {groups.map((group) => (
        <View key={group.bucket} style={styles.statusGroupBlock}>
          <StatusGroupHeader group={group} collapsed={collapsedStatusGroupKeys.has(group.bucket)} />
          {!collapsedStatusGroupKeys.has(group.bucket) ? (
            <View
              style={styles.statusWorkspaceListContainer}
              testID={`sidebar-status-group-rows-${group.bucket}`}
            >
              {group.rows.map((workspace) => (
                <StatusWorkspaceRow
                  key={workspace.workspaceKey}
                  workspace={workspace}
                  projectName={projectNamesByKey.get(workspace.projectKey) ?? ""}
                  serverId={serverId}
                  shortcutNumber={shortcutIndex.get(workspace.workspaceKey) ?? null}
                  showShortcutBadge={showShortcutBadges}
                  onWorkspacePress={onWorkspacePress}
                />
              ))}
            </View>
          ) : null}
        </View>
      ))}
    </>
  );
}

function StatusGroupHeader({ group, collapsed }: { group: StatusGroup; collapsed: boolean }) {
  const [isHovered, setIsHovered] = useState(false);
  const toggleStatusGroupCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleStatusGroupCollapsed,
  );
  const handlePress = useCallback(() => {
    toggleStatusGroupCollapsed(group.bucket);
  }, [group.bucket, toggleStatusGroupCollapsed]);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.statusGroupRow,
      isHovered && styles.statusGroupRowHovered,
      pressed && styles.statusGroupRowPressed,
    ],
    [isHovered],
  );
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);

  return (
    <View onPointerEnter={handleHoverIn} onPointerLeave={handleHoverOut}>
      <Pressable
        accessibilityRole={platformIsWeb ? undefined : "button"}
        accessibilityLabel={`${group.label} status group`}
        accessibilityState={accessibilityState}
        style={rowStyle}
        onPress={handlePress}
        testID={`sidebar-status-group-${group.bucket}`}
      >
        <View style={styles.statusGroupRowLeft}>
          <View style={styles.statusGroupLeadingVisualSlot}>
            <StatusGroupLeadingVisual
              bucket={group.bucket}
              collapsed={collapsed}
              showChevron={isHovered}
            />
          </View>
          <View style={styles.statusGroupTitleGroup}>
            <Text style={styles.statusGroupTitle} numberOfLines={1}>
              {group.label}
            </Text>
          </View>
        </View>
      </Pressable>
    </View>
  );
}

function StatusGroupLeadingVisual({
  bucket,
  collapsed,
  showChevron,
}: {
  bucket: StatusGroup["bucket"];
  collapsed: boolean;
  showChevron: boolean;
}) {
  if (!showChevron) {
    return <StatusGroupIcon bucket={bucket} />;
  }
  if (collapsed) {
    return <ThemedChevronRight size={14} uniProps={foregroundMutedColorMapping} />;
  }
  return <ThemedChevronDown size={14} uniProps={foregroundMutedColorMapping} />;
}

function StatusGroupIcon({ bucket }: { bucket: StatusGroup["bucket"] }) {
  switch (bucket) {
    case "needs_input":
      return <ThemedCircleAlert size={14} uniProps={amberColorMapping} />;
    case "failed":
      return <ThemedCircleX size={14} uniProps={redColorMapping} />;
    case "attention":
      return <ThemedCircleCheck size={14} uniProps={greenColorMapping} />;
    case "running":
      return <ThemedCircleDot size={14} uniProps={blueColorMapping} />;
    case "done":
      return <ThemedCircleCheck size={14} uniProps={foregroundMutedColorMapping} />;
  }
}

const StatusWorkspaceRow = memo(function StatusWorkspaceRow({
  workspace,
  projectName,
  serverId,
  shortcutNumber,
  showShortcutBadge,
  onWorkspacePress,
}: {
  workspace: SidebarWorkspaceEntry;
  projectName: string;
  serverId: string | null;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  onWorkspacePress?: () => void;
}) {
  const hydratedWorkspace = useSidebarWorkspaceEntry(serverId, workspace.workspaceId);
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const selected =
    activeWorkspaceSelection?.serverId === workspace.serverId &&
    activeWorkspaceSelection?.workspaceId === workspace.workspaceId;

  const handlePress = useCallback(() => {
    if (!serverId) return;
    onWorkspacePress?.();
    navigateToWorkspace(serverId, workspace.workspaceId);
  }, [serverId, onWorkspacePress, workspace.workspaceId]);

  if (!hydratedWorkspace) return null;

  return (
    <SidebarWorkspaceRow
      workspace={hydratedWorkspace}
      selected={selected}
      shortcutNumber={shortcutNumber}
      showShortcutBadge={showShortcutBadge}
      canCopyBranchName={hydratedWorkspace.projectKind === "git"}
      onPress={handlePress}
      subtitle={projectName}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  statusGroupBlock: {
    marginBottom: theme.spacing[1],
  },
  statusWorkspaceListContainer: {},
  statusGroupRow: {
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  statusGroupRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  statusGroupRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  statusGroupRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  statusGroupLeadingVisualSlot: {
    position: "relative",
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  statusGroupTitleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  statusGroupTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "400",
    minWidth: 0,
    flexShrink: 1,
  },
}));
