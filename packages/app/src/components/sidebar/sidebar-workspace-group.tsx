import { useCallback, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleX,
  Folder,
} from "lucide-react-native";
import { isNative as platformIsNative, isWeb as platformIsWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import type { StatusBucket } from "@/hooks/sidebar-status-view-model";
import type { SidebarWorkspaceGroup } from "./sidebar-labels";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { getStatusDotColor } from "@/utils/status-dot-color";
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
// One mapping per bucket, resolved through the status-dot producer so a group header and
// the rows under it cannot disagree about what "failed" looks like.
const needsInputColorMapping = (theme: Theme) => ({
  color: getStatusDotColor({ theme, bucket: "needs_input" }) ?? undefined,
});
const failedColorMapping = (theme: Theme) => ({
  color: getStatusDotColor({ theme, bucket: "failed" }) ?? undefined,
});
const attentionColorMapping = (theme: Theme) => ({
  color: getStatusDotColor({ theme, bucket: "attention" }) ?? undefined,
});
const runningColorMapping = (theme: Theme) => ({
  color: getStatusDotColor({ theme, bucket: "running" }) ?? undefined,
});

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedFolder = withUnistyles(Folder);
const ThemedCircleX = withUnistyles(CircleX);

/** Render the same optional empty-project section in either grouping mode. */
export function SidebarEmptyProjectGroup({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const separate = useSidebarViewStore((state) => state.groupEmptyProjects);
  const collapsed = useSidebarCollapsedSectionsStore((state) =>
    state.collapsedWorkspaceGroupKeys.has("no-unarchived-workspaces"),
  );
  // Keep the persisted collapse key stable when the section label changes.
  const group = useMemo(
    () => ({
      key: "no-unarchived-workspaces",
      label: t("sidebar.display.projectVisibility.emptyGroup"),
      leading: { kind: "project" as const },
    }),
    [t],
  );
  if (!separate) return children;
  return (
    <View style={styles.emptyProjectGroup} testID="sidebar-empty-project-group">
      <SidebarWorkspaceGroupHeader group={group} collapsed={collapsed} />
      {collapsed ? null : children}
    </View>
  );
}

interface SidebarWorkspaceGroupHeading {
  key: string;
  label: string;
  leading: SidebarWorkspaceGroup["leading"] | { kind: "project" };
}

interface SidebarWorkspaceGroupHeaderProps {
  group: SidebarWorkspaceGroupHeading;
  collapsed: boolean;
}

/** Collapsible section header shared by status buckets and the empty-project section. */
export function SidebarWorkspaceGroupHeader({
  group,
  collapsed,
}: SidebarWorkspaceGroupHeaderProps) {
  const isCompact = useIsCompactFormFactor();
  const toggleWorkspaceGroupCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleWorkspaceGroupCollapsed,
  );
  const handlePress = useCallback(() => {
    toggleWorkspaceGroupCollapsed(group.key);
  }, [group.key, toggleWorkspaceGroupCollapsed]);
  const rowStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.statusGroupRow,
      hovered && styles.statusGroupRowHovered,
      pressed && styles.statusGroupRowPressed,
    ],
    [],
  );
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);

  const renderContent = useCallback(
    ({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => (
      <View style={styles.statusGroupRowLeft}>
        <View style={styles.statusGroupLeadingVisualSlot}>
          <StatusGroupLeadingVisual
            leading={group.leading}
            collapsed={collapsed}
            showChevron={hovered || platformIsNative || isCompact}
          />
        </View>
        <View style={styles.statusGroupTitleGroup}>
          <Text style={styles.statusGroupTitle} numberOfLines={1}>
            {group.label}
          </Text>
        </View>
      </View>
    ),
    [collapsed, group.leading, group.label, isCompact],
  );

  return (
    <Pressable
      accessibilityRole={platformIsWeb ? undefined : "button"}
      accessibilityLabel={`${group.label} group`}
      accessibilityState={accessibilityState}
      style={rowStyle}
      onPress={handlePress}
      testID={`sidebar-status-group-${group.key}`}
    >
      {renderContent}
    </Pressable>
  );
}

function StatusGroupLeadingVisual({
  leading,
  collapsed,
  showChevron,
}: {
  leading: SidebarWorkspaceGroup["leading"] | { kind: "project" };
  collapsed: boolean;
  showChevron: boolean;
}) {
  if (!showChevron) {
    return leading.kind === "project" ? (
      <ThemedFolder size={14} uniProps={foregroundMutedColorMapping} />
    ) : (
      <StatusGroupIcon bucket={leading.bucket} />
    );
  }
  if (collapsed) {
    return <ThemedChevronRight size={14} uniProps={foregroundMutedColorMapping} />;
  }
  return <ThemedChevronDown size={14} uniProps={foregroundMutedColorMapping} />;
}

function StatusGroupIcon({ bucket }: { bucket: StatusBucket }) {
  switch (bucket) {
    case "needs_input":
      return <ThemedCircleAlert size={14} uniProps={needsInputColorMapping} />;
    case "failed":
      return <ThemedCircleX size={14} uniProps={failedColorMapping} />;
    case "attention":
      return <ThemedCircleCheck size={14} uniProps={attentionColorMapping} />;
    case "running":
      return <ThemedCircleDot size={14} uniProps={runningColorMapping} />;
    case "done":
      return <ThemedCircleCheck size={14} uniProps={foregroundMutedColorMapping} />;
  }
}

const styles = StyleSheet.create((theme) => ({
  emptyProjectGroup: { paddingBottom: theme.spacing[3] },
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
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    minWidth: 0,
    flexShrink: 1,
  },
}));
