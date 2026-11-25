import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpToLine,
  ChevronRight,
  Copy,
  GripVertical,
  MoreVertical,
  Pencil,
  Trash2,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { DraggableListHandle } from "@/components/draggable-list";
import { useOpenKebabMenuVisibility } from "@/components/sidebar/use-open-kebab-menu-visibility";
import { bySizing, TOUCH_TARGET } from "@/components/ui/control-geometry";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  extraMutedIconColorMapping,
  foregroundIconColorMapping,
  mutedIconColorMapping,
} from "@/components/ui/icon-color";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePointerCapabilities } from "@/hooks/pointer-capabilities";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { AgentProfileGlyph } from "../internal/agent-profile-glyph";
import { buildAgentProfileRosterSummary } from "../internal/profile-summary";

/** Shared column & rail geometry consumed by both RosterTableHeader and AgentProfileRow. */
export const ROSTER_COL_PROFILE_WIDTH = 184;
export const ROSTER_COL_RUNTIME_WIDTH = 248;
export const ROSTER_GRIP_WIDTH = bySizing({ touch: 28, pointer: 20 });
export const ROSTER_TRAILING_WIDTH = bySizing({ touch: TOUCH_TARGET + 14, pointer: 42 });

const ROW_MIN_HEIGHT = bySizing({ touch: TOUCH_TARGET + 16, pointer: 56 });
const GRIP_HANDLE_HEIGHT = bySizing({ touch: TOUCH_TARGET, pointer: 28 });

const ThemedGripVertical = withUnistyles(GripVertical);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedPencil = withUnistyles(Pencil);
const ThemedCopy = withUnistyles(Copy);
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const ThemedArrowUpToLine = withUnistyles(ArrowUpToLine);
const ThemedTrash2 = withUnistyles(Trash2);

const destructiveIconColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const editMenuIcon = <ThemedPencil size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;
const duplicateMenuIcon = <ThemedCopy size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;
const moveUpMenuIcon = <ThemedArrowUp size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;
const moveDownMenuIcon = <ThemedArrowDown size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;
const moveTopMenuIcon = (
  <ThemedArrowUpToLine size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />
);
const removeMenuIcon = <ThemedTrash2 size={ICON_SIZE.sm} uniProps={destructiveIconColorMapping} />;

const HIDDEN_FROM_ASSISTIVE_TECH = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
  "aria-hidden": true,
} as const;

export interface AgentProfileRowProps {
  serverId: string;
  profile: AgentProfile;
  entries: readonly ProviderSnapshotEntry[] | undefined;
  isFirst: boolean;
  isLast: boolean;
  selected?: boolean;
  dragging?: boolean;
  /** Stacked layout when narrow or on compact form factors. */
  compactLayout?: boolean;
  /** Hides the drag handle when showing filtered search results while preserving the rail. */
  reorderable?: boolean;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  onMoveToTop: (id: string) => void;
}

function AgentProfileRowMenu({
  profileId,
  profileName,
  isFirst,
  isLast,
  reorderable,
  menuProps,
  onEdit,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  onMoveToTop,
  onRemove,
}: {
  profileId: string;
  profileName: string;
  isFirst: boolean;
  isLast: boolean;
  reorderable: boolean;
  menuProps: { open: boolean; onOpenChange: (open: boolean) => void };
  onEdit: () => void;
  onDuplicate: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMoveToTop: () => void;
  onRemove: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const showReorderItems = reorderable && (!isFirst || !isLast);
  return (
    <DropdownMenu {...menuProps} compactMode="sheet">
      <ToolbarButton
        kind="menu"
        label={t("settings.host.agentProfiles.profileActions", { name: profileName })}
        testID={`agent-profile-menu-${profileId}`}
      >
        <ThemedMoreVertical size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />
      </ToolbarButton>
      <DropdownMenuContent side="bottom" align="end" width={180}>
        <DropdownMenuItem
          leading={editMenuIcon}
          onSelect={onEdit}
          testID={`agent-profile-edit-${profileId}`}
        >
          {t("settings.host.agentProfiles.editProfile")}
        </DropdownMenuItem>
        <DropdownMenuItem
          leading={duplicateMenuIcon}
          onSelect={onDuplicate}
          testID={`agent-profile-duplicate-${profileId}`}
        >
          {t("settings.host.agentProfiles.duplicate")}
        </DropdownMenuItem>
        {showReorderItems ? (
          <>
            <DropdownMenuSeparator />
            {!isFirst ? (
              <DropdownMenuItem
                leading={moveUpMenuIcon}
                onSelect={onMoveUp}
                testID={`agent-profile-move-up-${profileId}`}
              >
                {t("settings.host.agentProfiles.moveUp")}
              </DropdownMenuItem>
            ) : null}
            {!isLast ? (
              <DropdownMenuItem
                leading={moveDownMenuIcon}
                onSelect={onMoveDown}
                testID={`agent-profile-move-down-${profileId}`}
              >
                {t("settings.host.agentProfiles.moveDown")}
              </DropdownMenuItem>
            ) : null}
            {!isFirst ? (
              <DropdownMenuItem
                leading={moveTopMenuIcon}
                onSelect={onMoveToTop}
                testID={`agent-profile-move-top-${profileId}`}
              >
                {t("settings.host.agentProfiles.moveToTop")}
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          destructive
          leading={removeMenuIcon}
          onSelect={onRemove}
          testID={`agent-profile-remove-${profileId}`}
        >
          {t("settings.host.agentProfiles.remove")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AgentProfileRowContent({
  serverId,
  profile,
  modelLabel,
  providerLabel,
  runtimeSubline,
  fullSummary,
  isStacked,
}: {
  serverId: string;
  profile: AgentProfile;
  modelLabel: string | null;
  providerLabel: string;
  runtimeSubline: string;
  fullSummary: string;
  isStacked: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const iconTile = (
    <View style={styles.iconTile}>
      <AgentProfileGlyph
        icon={profile.icon}
        color={profile.color}
        provider={profile.provider}
        serverId={serverId}
        size={ICON_SIZE.sm}
      />
    </View>
  );

  if (isStacked) {
    return (
      <View style={[styles.stackedMain, styles.passThrough]}>
        {iconTile}
        <View style={styles.stackedContent}>
          <Text style={styles.nameText} numberOfLines={1}>
            {profile.name}
          </Text>
          <View style={styles.stackedSpecLine}>
            <AgentProfileGlyph
              provider={profile.provider}
              serverId={serverId}
              size={ICON_SIZE.xs}
            />
            <Text style={styles.stackedSpecText} numberOfLines={1}>
              {fullSummary}
            </Text>
          </View>
          {profile.notes ? (
            <Text
              style={styles.stackedNotesText}
              numberOfLines={2}
              testID={`agent-profile-notes-${profile.id}`}
            >
              {profile.notes}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.columns, styles.passThrough]}>
      <View style={styles.colProfile}>
        {iconTile}
        <Text style={styles.nameText} numberOfLines={1}>
          {profile.name}
        </Text>
      </View>
      <View style={styles.colRuntime}>
        <View style={styles.modelLine}>
          <AgentProfileGlyph provider={profile.provider} serverId={serverId} size={ICON_SIZE.xs} />
          <Text style={styles.modelText} numberOfLines={1}>
            {modelLabel ?? providerLabel}
          </Text>
        </View>
        <Text style={styles.runtimeSubtext} numberOfLines={1}>
          {runtimeSubline}
        </Text>
      </View>
      <View style={styles.colNotes}>
        {profile.notes ? (
          <Text
            style={styles.notesText}
            numberOfLines={2}
            testID={`agent-profile-notes-${profile.id}`}
          >
            {profile.notes}
          </Text>
        ) : (
          <Text style={styles.notesEmptyText} numberOfLines={1}>
            {t("settings.host.agentProfiles.noRoutingNote")}
          </Text>
        )}
      </View>
    </View>
  );
}

/**
 * Wide roster row (Profile | Model & runtime | When to use) that stacks on narrow panes.
 *
 * Follows docs/hover.md: hover lives on the outer plain View, tap lives on an
 * underlying PressHighlight, and the kebab menu's open state is lifted via
 * `useOpenKebabMenuVisibility` so losing hover never unmounts an open menu.
 */
export function AgentProfileRow({
  serverId,
  profile,
  entries,
  isFirst,
  isLast,
  selected = false,
  dragging = false,
  compactLayout = false,
  reorderable = true,
  onEdit,
  onDuplicate,
  onRemove,
  onMoveUp,
  onMoveDown,
  onMoveToTop,
}: AgentProfileRowProps): ReactElement {
  const { t } = useTranslation();
  const isCompactFormFactor = useIsCompactFormFactor();
  const { finePointer, touchScreen } = usePointerCapabilities();
  const [isHovered, setIsHovered] = useState(false);

  const alwaysShowAffordances = !finePointer || touchScreen || isCompactFormFactor;
  const { showKebab, menuProps } = useOpenKebabMenuVisibility(
    isHovered || dragging || alwaysShowAffordances,
  );
  const showRowAffordances = showKebab;

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const handleEdit = useCallback(() => onEdit(profile.id), [onEdit, profile.id]);
  const handleDuplicate = useCallback(() => onDuplicate(profile.id), [onDuplicate, profile.id]);
  const handleRemove = useCallback(() => onRemove(profile.id), [onRemove, profile.id]);
  const handleMoveUp = useCallback(() => onMoveUp(profile.id), [onMoveUp, profile.id]);
  const handleMoveDown = useCallback(() => onMoveDown(profile.id), [onMoveDown, profile.id]);
  const handleMoveToTop = useCallback(() => onMoveToTop(profile.id), [onMoveToTop, profile.id]);

  const formatFeatureCount = useCallback(
    (count: number) =>
      count === 1
        ? t("settings.host.agentProfiles.featureCountOne", { count })
        : t("settings.host.agentProfiles.featureCount", { count }),
    [t],
  );

  const rosterSummary = useMemo(
    () => buildAgentProfileRosterSummary({ profile, entries, formatFeatureCount }),
    [entries, formatFeatureCount, profile],
  );
  const fullSummary = useMemo(
    () => rosterSummary.allTags.map((tag) => tag.label).join(" · "),
    [rosterSummary.allTags],
  );
  const runtimeSubline = useMemo(
    () => rosterSummary.runtimeDetails.join(" · "),
    [rosterSummary.runtimeDetails],
  );

  const isStacked = compactLayout || isCompactFormFactor;

  const rowContainerStyle = useMemo(
    () => [
      styles.row,
      !isFirst && settingsStyles.rowBorder,
      selected && styles.rowSelected,
      (isHovered || menuProps.open) && !selected && styles.rowHovered,
      dragging && styles.rowDragging,
    ],
    [dragging, isFirst, isHovered, menuProps.open, selected],
  );

  const gripVisibilityStyle = useMemo(
    () => [styles.gripSlot, !showRowAffordances && styles.affordanceHidden],
    [showRowAffordances],
  );
  const kebabVisibilityStyle = useMemo(
    () => [styles.kebabSlot, !showRowAffordances && styles.affordanceHidden],
    [showRowAffordances],
  );

  return (
    <View
      style={rowContainerStyle}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID={`agent-profile-row-${profile.id}`}
    >
      <PressHighlight
        accessibilityRole="button"
        accessibilityLabel={`${profile.name}, ${fullSummary}`}
        onPress={handleEdit}
        style={styles.pressTarget}
        highlightStyle={styles.rowPressed}
        testID={`agent-profile-row-press-${profile.id}`}
      />

      {selected ? <View style={styles.selectedIndicator} pointerEvents="none" /> : null}

      {reorderable ? (
        <View style={gripVisibilityStyle} pointerEvents={showRowAffordances ? "auto" : "none"}>
          <DraggableListHandle
            accessibilityLabel={t("settings.host.agentProfiles.reorderProfile", {
              name: profile.name,
            })}
            style={styles.gripHandle}
            testID={`agent-profile-drag-${profile.id}`}
          >
            <ThemedGripVertical size={ICON_SIZE.sm} uniProps={extraMutedIconColorMapping} />
          </DraggableListHandle>
        </View>
      ) : (
        <View style={isStacked ? styles.gripSpacerCompact : styles.gripSlot} />
      )}

      <AgentProfileRowContent
        serverId={serverId}
        profile={profile}
        modelLabel={rosterSummary.modelLabel}
        providerLabel={rosterSummary.providerLabel}
        runtimeSubline={runtimeSubline}
        fullSummary={fullSummary}
        isStacked={isStacked}
      />

      <View style={styles.trailing}>
        <View style={kebabVisibilityStyle} pointerEvents={showRowAffordances ? "auto" : "none"}>
          <AgentProfileRowMenu
            profileId={profile.id}
            profileName={profile.name}
            isFirst={isFirst}
            isLast={isLast}
            reorderable={reorderable}
            menuProps={menuProps}
            onEdit={handleEdit}
            onDuplicate={handleDuplicate}
            onMoveUp={handleMoveUp}
            onMoveDown={handleMoveDown}
            onMoveToTop={handleMoveToTop}
            onRemove={handleRemove}
          />
        </View>
        <View style={[styles.chevron, styles.passThrough]} {...HIDDEN_FROM_ASSISTIVE_TECH}>
          <ThemedChevronRight
            size={ICON_SIZE.sm}
            uniProps={isHovered || selected ? foregroundIconColorMapping : mutedIconColorMapping}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    minHeight: ROW_MIN_HEIGHT,
    paddingVertical: theme.spacing[3],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[4],
    gap: theme.spacing[2],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowSelected: {
    backgroundColor: theme.colors.surface3,
  },
  selectedIndicator: {
    position: "absolute",
    left: 0,
    top: theme.spacing[2],
    bottom: theme.spacing[2],
    width: theme.borderWidth[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  rowDragging: {
    backgroundColor: theme.colors.surface2,
  },
  pressTarget: {
    ...StyleSheet.absoluteFill,
  },
  passThrough: {
    pointerEvents: "none",
  },
  gripSlot: {
    width: ROSTER_GRIP_WIDTH,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  gripSpacerCompact: {
    width: theme.spacing[2],
    flexShrink: 0,
  },
  gripHandle: {
    width: ROSTER_GRIP_WIDTH,
    height: GRIP_HANDLE_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
  },
  affordanceHidden: {
    opacity: 0,
  },
  iconTile: {
    width: theme.spacing[7],
    height: theme.spacing[7],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  columns: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
  },
  colProfile: {
    width: ROSTER_COL_PROFILE_WIDTH,
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  colRuntime: {
    width: ROSTER_COL_RUNTIME_WIDTH,
    flexShrink: 0,
    gap: theme.spacing[0.5],
    minWidth: 0,
  },
  colNotes: {
    flex: 1,
    minWidth: 0,
  },
  nameText: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  modelLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minWidth: 0,
  },
  modelText: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  runtimeSubtext: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  notesText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  notesEmptyText: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  stackedMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  stackedContent: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  stackedSpecLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minWidth: 0,
  },
  stackedSpecText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  stackedNotesText: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[0.5],
  },
  trailing: {
    width: ROSTER_TRAILING_WIDTH,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  kebabSlot: {
    alignItems: "center",
    justifyContent: "center",
  },
  // Optical: matches SettingsRowHeader so the chevron sits on the card's trailing rail.
  chevron: {
    marginRight: -theme.spacing[1],
  },
}));
