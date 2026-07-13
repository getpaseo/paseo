import { memo, useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronDown, ChevronRight, MoreVertical, Pencil, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import {
  navigateToWorkspace,
  useActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { MemoSidebarWorkspaceRow } from "@/components/sidebar/sidebar-workspace-row";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isWeb } from "@/constants/platform";
import { SidebarWorkspaceLabelDot } from "@/components/sidebar/sidebar-workspace-label-dot";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash2 = withUnistyles(Trash2);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const renameLeading = <ThemedPencil size={14} uniProps={foregroundMutedColorMapping} />;
const deleteLeading = <ThemedTrash2 size={14} uniProps={foregroundMutedColorMapping} />;

export interface SidebarWorkspaceSectionModel {
  key: string;
  label: string;
  rows: SidebarWorkspaceEntry[];
  compactHeader?: boolean;
  showProjectSubtitle?: boolean;
  markerKey?: string | null;
  collapsed?: boolean;
  onToggle?: () => void;
  onClear?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}

interface SidebarWorkspaceSectionsProps {
  sections: readonly SidebarWorkspaceSectionModel[];
  shortcutIndexByWorkspaceKey: ReadonlyMap<string, number>;
  showShortcutBadges: boolean;
  projectNamesByKey: ReadonlyMap<string, string>;
  hostLabelByServerId: ReadonlyMap<string, string>;
  showHostLabels: boolean;
  onWorkspacePress?: () => void;
  showHeaders?: boolean;
}

export function SidebarWorkspaceSections({
  sections,
  shortcutIndexByWorkspaceKey,
  showShortcutBadges,
  projectNamesByKey,
  hostLabelByServerId,
  showHostLabels,
  onWorkspacePress,
  showHeaders = true,
}: SidebarWorkspaceSectionsProps): ReactElement {
  return (
    <>
      {sections.map((section) => (
        <View key={section.key} style={styles.section} testID={`sidebar-section-${section.key}`}>
          {showHeaders ? <SectionHeader section={section} /> : null}
          {!section.collapsed ? (
            <View style={styles.rows} testID={`sidebar-section-rows-${section.key}`}>
              {section.rows.map((workspace) => (
                <OrganizationWorkspaceRow
                  key={workspace.workspaceKey}
                  workspace={workspace}
                  shortcutNumber={shortcutIndexByWorkspaceKey.get(workspace.workspaceKey) ?? null}
                  showShortcutBadge={showShortcutBadges}
                  projectName={projectNamesByKey.get(workspace.projectKey) ?? workspace.projectName}
                  showProjectSubtitle={section.showProjectSubtitle !== false}
                  hostLabel={
                    showHostLabels
                      ? (hostLabelByServerId.get(workspace.serverId) ?? workspace.serverId)
                      : null
                  }
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

function SectionHeader({ section }: { section: SidebarWorkspaceSectionModel }): ReactElement {
  const headerStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.headerPressable,
      section.compactHeader && styles.headerPressableCompact,
      (hovered || pressed) && styles.headerPressableActive,
    ],
    [section.compactHeader],
  );
  const headerLabelStyle = section.compactHeader ? styles.headerLabelCompact : styles.headerLabel;
  const chevron = section.collapsed ? (
    <ThemedChevronRight size={14} uniProps={foregroundMutedColorMapping} />
  ) : (
    <ThemedChevronDown size={14} uniProps={foregroundMutedColorMapping} />
  );
  let headerLeading: ReactElement | null = null;
  if (section.onToggle) headerLeading = chevron;
  else if (!section.compactHeader) headerLeading = <View style={styles.chevronSpacer} />;
  const accessibilityState = useMemo(() => ({ expanded: !section.collapsed }), [section.collapsed]);
  return (
    <View style={styles.header}>
      <Pressable
        disabled={!section.onToggle}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        style={headerStyle}
        onPress={section.onToggle}
      >
        {headerLeading}
        {section.markerKey ? (
          <SidebarWorkspaceLabelDot labelKey={section.markerKey} label={section.label} />
        ) : null}
        <Text numberOfLines={1} style={headerLabelStyle}>
          {section.label}
        </Text>
        <Text style={styles.count}>{section.rows.length}</Text>
      </Pressable>
      {section.onClear ? (
        <Button variant="ghost" size="xs" onPress={section.onClear}>
          Unhide all
        </Button>
      ) : null}
      {section.onRename || section.onDelete ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            accessibilityRole={isWeb ? undefined : "button"}
            accessibilityLabel={`${section.label} actions`}
            style={styles.menuTrigger}
          >
            <ThemedMoreVertical size={14} uniProps={foregroundMutedColorMapping} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" width={220}>
            {section.onRename ? (
              <DropdownMenuItem leading={renameLeading} onSelect={section.onRename}>
                Rename workspace label
              </DropdownMenuItem>
            ) : null}
            {section.onDelete ? (
              <DropdownMenuItem destructive leading={deleteLeading} onSelect={section.onDelete}>
                Delete workspace label
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </View>
  );
}

const OrganizationWorkspaceRow = memo(function OrganizationWorkspaceRow({
  workspace,
  shortcutNumber,
  showShortcutBadge,
  projectName,
  showProjectSubtitle,
  hostLabel,
  onWorkspacePress,
}: {
  workspace: SidebarWorkspaceEntry;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  projectName: string;
  showProjectSubtitle: boolean;
  hostLabel: string | null;
  onWorkspacePress?: () => void;
}): ReactElement {
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const selected =
    activeWorkspaceSelection?.serverId === workspace.serverId &&
    activeWorkspaceSelection?.workspaceId === workspace.workspaceId;
  const subtitle = useMemo(() => {
    if (!showProjectSubtitle) return null;
    return hostLabel ? `${projectName} · ${hostLabel}` : projectName;
  }, [hostLabel, projectName, showProjectSubtitle]);
  const handlePress = useCallback(() => {
    onWorkspacePress?.();
    navigateToWorkspace(workspace.serverId, workspace.workspaceId);
  }, [onWorkspacePress, workspace.serverId, workspace.workspaceId]);

  return (
    <MemoSidebarWorkspaceRow
      workspace={workspace}
      selected={selected}
      shortcutNumber={shortcutNumber}
      showShortcutBadge={showShortcutBadge}
      canCopyBranchName={workspace.currentBranch !== null}
      subtitle={subtitle}
      onPress={handlePress}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  section: { marginBottom: theme.spacing[2] },
  header: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    paddingRight: theme.spacing[2],
  },
  headerPressable: {
    minWidth: 0,
    flex: 1,
    minHeight: 30,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  headerPressableActive: { backgroundColor: theme.colors.surfaceSidebarHover },
  headerPressableCompact: {
    minHeight: 24,
  },
  headerLabel: {
    minWidth: 0,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  headerLabelCompact: {
    minWidth: 0,
    flexShrink: 1,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  count: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  chevronSpacer: { width: 14 },
  rows: { paddingLeft: theme.spacing[4] },
  menuTrigger: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
}));
