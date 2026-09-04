import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  MoreVertical,
  Pencil,
  Ungroup,
} from "lucide-react-native";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuHint,
  DropdownMenuItem,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  useDropdownMenuClose,
} from "@/components/ui/dropdown-menu";
import type { SidebarProjectGroup } from "@/components/sidebar/sidebar-projection";
import {
  useProjectGroupHeaderDroppable,
  type ProjectGroupDragHandle,
} from "@/components/sidebar/project-drag-context";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { setProjectGroupOnProjects } from "@/project-groups";
import {
  PROJECT_GROUP_RENAME_PAGE_ID,
  useProjectGroupMutation,
  useProjectGroupRenamePages,
} from "@/project-groups/picker";
import type { Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedPencil = withUnistyles(Pencil);
const ThemedUngroup = withUnistyles(Ungroup);
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const renameLeadingIcon = <ThemedPencil size={14} uniProps={foregroundMutedColorMapping} />;
const ungroupLeadingIcon = <ThemedUngroup size={14} uniProps={foregroundMutedColorMapping} />;
const moveUpLeadingIcon = <ThemedArrowUp size={14} uniProps={foregroundMutedColorMapping} />;
const moveDownLeadingIcon = <ThemedArrowDown size={14} uniProps={foregroundMutedColorMapping} />;

/**
 * Everyone a whole-group write names: the members the hosts have confirmed, read when the write
 * starts rather than when the header rendered.
 *
 * A host answers a move before it pushes the project, so for that moment a row on its way into
 * the group is in neither list, and a rename issued inside that window leaves it behind under
 * the old name. Guessing at those rows from the client's own record of pending moves was worse:
 * the record goes stale whenever another surface writes the group, and a rename then reaches a
 * project that had already moved elsewhere. Missing a row is visible and can be repeated; moving
 * someone else's project is neither.
 */
function wholeGroupMembers(group: SidebarProjectGroup): SidebarProjectEntry[] {
  return group.members;
}

export interface ProjectGroupMoveProps {
  /** Moves the group one place up (-1) or down (1) among the groups. */
  onMove: (groupKey: string, direction: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

/**
 * The header above the projects that share a group.
 *
 * It takes the project row's geometry (height, padding, radius, fills) so it sits in the same
 * column as the rows it opens, and it departs from them in the ways that make it a container
 * rather than one more row: the chevron is always there and says open or closed, the name is
 * weightier than a project's, and a closed group shows how many projects it hides. The members
 * are drawn stepped in under it by the list (see `projectGroupBody` in sidebar-workspace-list).
 *
 * Hover follows docs/hover.md: a plain View is the hover target, a separate Pressable is the
 * toggle, and the kebab (a Pressable of its own) sits inside the toggle like a project row's
 * trailing actions so one fill covers the whole row. On web the toggle is also the drag handle
 * for the whole group (`dragHandle`), the way a project row's own listeners sit on the row; a
 * plain click still toggles because the pointer has to travel before a drag starts.
 */
export function ProjectGroupHeader({
  group,
  collapsed,
  onToggle,
  dragHandle,
  move,
}: {
  group: SidebarProjectGroup;
  collapsed: boolean;
  onToggle: (groupKey: string) => void;
  dragHandle?: ProjectGroupDragHandle;
  move: ProjectGroupMoveProps;
}): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Keyboard users reach the kebab by tabbing; opacity alone would leave them on a control they
  // cannot see.
  const [kebabFocused, setKebabFocused] = useState(false);
  const { setNodeRef: setDropRef, isOver: isDropTarget } = useProjectGroupHeaderDroppable(group);
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  // React Native Web does not map `accessibilityState.expanded` to `aria-expanded`, so the web
  // attribute is set by hand, the same workaround header toggles and composer pills use.
  const ariaExpandedProps = isWeb ? { "aria-expanded": !collapsed } : null;
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleToggle = useCallback(() => onToggle(group.key), [group.key, onToggle]);
  const Chevron = collapsed ? ThemedChevronRight : ThemedChevronDown;
  const kebabVisible = isHovered || menuOpen || kebabFocused || isNative || isCompact;
  const handleKebabFocus = useCallback(() => setKebabFocused(true), []);
  const handleKebabBlur = useCallback(() => setKebabFocused(false), []);
  const toggleStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.toggle,
      isHovered && styles.toggleHovered,
      pressed && styles.togglePressed,
      isDropTarget && styles.toggleDropTarget,
    ],
    [isDropTarget, isHovered],
  );

  return (
    <View
      ref={setDropRef}
      style={styles.container}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID={`sidebar-project-group-header-${group.key}`}
    >
      <Pressable
        ref={dragHandle?.setActivatorNodeRef}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        {...ariaExpandedProps}
        {...dragHandle?.listeners}
        onPress={handleToggle}
        style={toggleStyle}
        testID={`sidebar-project-group-toggle-${group.key}`}
      >
        <View style={styles.leadingSlot}>
          <Chevron
            size={14}
            uniProps={isHovered ? foregroundColorMapping : foregroundMutedColorMapping}
          />
        </View>
        <Text style={[styles.title, isDropTarget && styles.titleDropTarget]} numberOfLines={1}>
          {group.name}
        </Text>
        {collapsed ? (
          <Text style={styles.count} testID={`sidebar-project-group-count-${group.key}`}>
            {group.projects.length}
          </Text>
        ) : null}
        <View
          style={[styles.trailing, !kebabVisible && styles.kebabHidden]}
          pointerEvents={kebabVisible ? "auto" : "none"}
        >
          <ProjectGroupKebabMenu
            group={group}
            move={move}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            onFocus={handleKebabFocus}
            onBlur={handleKebabBlur}
          />
        </View>
      </Pressable>
    </View>
  );
}

/** The header as it follows the pointer in a group drag: name and count, nothing to press. */
export function ProjectGroupHeaderChip({ group }: { group: SidebarProjectGroup }): ReactElement {
  return (
    <View style={[styles.toggle, styles.toggleHovered]}>
      <View style={styles.leadingSlot}>
        <ThemedChevronRight size={14} uniProps={foregroundColorMapping} />
      </View>
      <Text style={styles.title} numberOfLines={1}>
        {group.name}
      </Text>
      <Text style={styles.count}>{group.projects.length}</Text>
    </View>
  );
}

function ProjectGroupKebabMenu({
  group,
  move,
  open,
  onOpenChange,
  onFocus,
  onBlur,
}: {
  group: SidebarProjectGroup;
  move: ProjectGroupMoveProps;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFocus: () => void;
  onBlur: () => void;
}): ReactElement {
  const { t } = useTranslation();
  // Stable identity: the rename page is memoized on it, and a new function every render would
  // rebuild the menu's pages while someone is typing in one.
  const resolveMembers = useCallback(() => wholeGroupMembers(group), [group]);
  const pages = useProjectGroupRenamePages({ name: group.name, resolveMembers });
  const handleMoveUp = useCallback(() => move.onMove(group.key, -1), [group.key, move]);
  const handleMoveDown = useCallback(() => move.onMove(group.key, 1), [group.key, move]);
  return (
    <DropdownMenu compactMode="sheet" open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        hitSlop={8}
        style={kebabStyle}
        accessibilityRole={isWeb ? undefined : "button"}
        accessibilityLabel={t("sidebar.project.group.headerMenu")}
        onFocus={onFocus}
        onBlur={onBlur}
        testID={`sidebar-project-group-kebab-${group.key}`}
      >
        {renderKebabIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        width={220}
        pages={pages}
        sheetTitle={t("sidebar.project.group.headerMenu")}
      >
        <DropdownMenuItem
          leading={moveUpLeadingIcon}
          disabled={!move.canMoveUp}
          onSelect={handleMoveUp}
          testID={`sidebar-project-group-menu-move-up-${group.key}`}
        >
          {t("sidebar.project.group.moveUp")}
        </DropdownMenuItem>
        <DropdownMenuItem
          leading={moveDownLeadingIcon}
          disabled={!move.canMoveDown}
          onSelect={handleMoveDown}
          testID={`sidebar-project-group-menu-move-down-${group.key}`}
        >
          {t("sidebar.project.group.moveDown")}
        </DropdownMenuItem>
        <DropdownMenuSubTrigger
          id={PROJECT_GROUP_RENAME_PAGE_ID}
          leading={renameLeadingIcon}
          testID={`sidebar-project-group-menu-rename-${group.key}`}
        >
          {t("sidebar.project.group.rename")}
        </DropdownMenuSubTrigger>
        <UngroupMenuItem group={group} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Clears the group on every member, including any a filter is hiding right now. */
function UngroupMenuItem({ group }: { group: SidebarProjectGroup }): ReactElement {
  const { t } = useTranslation();
  const mutation = useProjectGroupMutation(useDropdownMenuClose());
  const handleSelect = useCallback(() => {
    void mutation.run(() =>
      setProjectGroupOnProjects({ projects: wholeGroupMembers(group), group: null }),
    );
  }, [group, mutation]);
  return (
    <>
      <DropdownMenuItem
        leading={ungroupLeadingIcon}
        status={mutation.pending ? "pending" : "idle"}
        pendingLabel={t("sidebar.project.group.ungrouping")}
        closeOnSelect={false}
        onSelect={handleSelect}
        testID={`sidebar-project-group-menu-ungroup-${group.key}`}
      >
        {t("sidebar.project.group.ungroup")}
      </DropdownMenuItem>
      {mutation.error ? (
        <DropdownMenuHint testID={`sidebar-project-group-menu-error-${group.key}`}>
          {mutation.error}
        </DropdownMenuHint>
      ) : null}
    </>
  );
}

function renderKebabIcon({ hovered }: { hovered?: boolean }) {
  return (
    <ThemedMoreVertical
      size={14}
      uniProps={hovered ? foregroundColorMapping : foregroundMutedColorMapping}
    />
  );
}

function kebabStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebab, hovered && styles.kebabHovered];
}

const styles = StyleSheet.create((theme) => ({
  // Only the hover target; layout lives on the toggle (docs/hover.md).
  container: {
    position: "relative",
  },
  // Kept in step with `projectRow` in sidebar-workspace-list.tsx: the header stands in the
  // project column, so it takes a project row's height, padding, radius, and both fills.
  toggle: {
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[1],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  toggleHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  togglePressed: {
    backgroundColor: theme.colors.surface2,
  },
  // A row from another list is over the header: the whole group is the target, so the whole
  // header fills, and the name takes the accent the drop zones use for the same state.
  toggleDropTarget: {
    backgroundColor: theme.colors.surface2,
  },
  titleDropTarget: {
    color: theme.colors.accent,
  },
  // The project rows' icon slot, so the chevron sits on the icon rail and the name on the title
  // rail. The members below step in by exactly this slot plus the gap (`projectGroupBody`).
  leadingSlot: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
    flexShrink: 0,
  },
  // Same pull onto the row rail as `projectTrailingActions`: MoreVertical paints only around the
  // center of its 14px SVG, so the 24px control's painted edge is drawn out through the unused
  // view-box space.
  trailing: {
    flexShrink: 0,
    marginRight: -6,
  },
  kebab: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  kebabHovered: {
    backgroundColor: theme.colors.surface2,
  },
  kebabHidden: {
    opacity: 0,
  },
}));
