import { memo, useCallback, useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from "react-native-svg";
import {
  CircleAlert,
  Folder,
  FolderGit2,
  GitPullRequest,
  Globe,
  Monitor,
  SquareTerminal,
} from "lucide-react-native";
import { HostBadge } from "@/components/sidebar/host-badge";
import { ProjectStatusIndicator } from "@/components/sidebar/project-leading-visual";
import { PulsingStatusDot } from "@/components/sidebar/pulsing-status-dot";
import { WorkspaceHoverCard } from "@/components/workspace-hover-card";
import type { HostBadgeModel } from "@/hosts/appearance";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useAppSettings } from "@/hooks/use-settings";
import type { Theme } from "@/styles/theme";
import type { PrHint } from "@/git/use-pr-status-query";
import { getForgePresentation, normalizeForge } from "@/git/forge";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor, isEmphasizedStatusDotBucket } from "@/utils/status-dot-color";
import { shouldRenderSyncedStatusLoader } from "@/utils/status-loader";
import { openExternalUrl } from "@/utils/open-external-url";
import { resolveSidebarWorkspacePrimaryLabel } from "@/components/sidebar/sidebar-workspace-title";

// The scrim spans more than the kebab so the fade starts left of the diff stat. Solid from
// SCRIM_SOLID_OFFSET rightward, which keeps the kebab itself off the gradient entirely.
const SCRIM_WIDTH = 48;
const SCRIM_SOLID_OFFSET = "55%";

const DEFAULT_STATUS_DOT_SIZE = 7;
const EMPHASIZED_STATUS_DOT_SIZE = 9;
const DEFAULT_STATUS_DOT_OFFSET = 0;
const EMPHASIZED_STATUS_DOT_OFFSET = -1;

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const amberColorMapping = (theme: Theme) => ({ color: theme.colors.palette.amber[500] });
const blueColorMapping = (theme: Theme) => ({ color: theme.colors.palette.blue[500] });
const greenColorMapping = (theme: Theme) => ({ color: theme.colors.palette.green[500] });
const redColorMapping = (theme: Theme) => ({ color: theme.colors.palette.red[500] });
const purpleColorMapping = (theme: Theme) => ({ color: theme.colors.palette.purple[500] });

const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedMonitor = withUnistyles(Monitor);
const ThemedFolder = withUnistyles(Folder);
const ThemedFolderGit2 = withUnistyles(FolderGit2);
const ThemedGlobe = withUnistyles(Globe);
const ThemedSquareTerminal = withUnistyles(SquareTerminal);

/**
 * react-native-svg's extractGradient reads stopColor off the child elements structurally,
 * without rendering them, so wrapping Stop itself in withUnistyles hides the color from it and
 * the native gradient silently falls back to black. Theme the whole SVG instead and keep real
 * Stop elements as direct children of the gradient.
 */
function TrailingActionScrimSvg({ gradientId, color }: { gradientId: string; color: string }) {
  return (
    <Svg width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <SvgLinearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
          {/* Same color at both ends, varying only stopOpacity. Interpolating a hex toward
              `transparent` goes through black in some engines and leaves a grey fringe. */}
          <Stop offset="0%" stopColor={color} stopOpacity={0} />
          <Stop offset={SCRIM_SOLID_OFFSET} stopColor={color} stopOpacity={1} />
          <Stop offset="100%" stopColor={color} stopOpacity={1} />
        </SvgLinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradientId})`} />
    </Svg>
  );
}

const ThemedTrailingActionScrimSvg = withUnistyles(TrailingActionScrimSvg);

const scrimColorMapping = (theme: Theme) => ({ color: theme.colors.surfaceSidebarHover });

function pullRequestIconStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    pullRequestIconStyles.pressable,
    (Boolean(hovered) || pressed) && pullRequestIconStyles.pressableActive,
  ];
}

type SidebarWorkspaceScriptIconKind = "service" | "command";

export function SidebarWorkspaceRowFrame({
  workspace,
  isDragging = false,
  children,
}: {
  workspace: SidebarWorkspaceEntry;
  isDragging?: boolean;
  children: (input: {
    isHovered: boolean;
    contextMenuOpen: boolean;
    onContextMenuOpenChange: (open: boolean) => void;
    hoverHandlers: { onPointerEnter: () => void; onPointerLeave: () => void };
  }) => ReactNode;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const handlePointerEnter = useCallback(() => {
    if (!contextMenuOpen) setIsHovered(true);
  }, [contextMenuOpen]);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleContextMenuOpenChange = useCallback((open: boolean) => {
    setContextMenuOpen(open);
    if (open) setIsHovered(false);
  }, []);
  const hoverHandlers = useMemo(
    () => ({ onPointerEnter: handlePointerEnter, onPointerLeave: handlePointerLeave }),
    [handlePointerEnter, handlePointerLeave],
  );

  return (
    <WorkspaceHoverCard
      workspace={workspace}
      prHint={workspace.prHint}
      isDragging={isDragging}
      disabled={contextMenuOpen}
    >
      {children({
        isHovered: isHovered && !contextMenuOpen,
        contextMenuOpen,
        onContextMenuOpenChange: handleContextMenuOpenChange,
        hoverHandlers,
      })}
    </WorkspaceHoverCard>
  );
}

export const SidebarWorkspaceRowContent = memo(function SidebarWorkspaceRowContent({
  workspace,
  hostBadge,
  leadingProjectName = null,
  leadingProjectIconDataUri = null,
  scriptIconKind = null,
  isHovered,
  isLoading,
  isCreating = false,
  shortcutNumber = null,
  showShortcutBadge = false,
  reserveIdleStatusIndicatorSpace = true,
  children,
}: {
  workspace: SidebarWorkspaceEntry;
  hostBadge?: HostBadgeModel | null;
  /** Hoisted rows use their project icon as the leading visual because no project row contains them. */
  leadingProjectName?: string | null;
  leadingProjectIconDataUri?: string | null;
  scriptIconKind?: SidebarWorkspaceScriptIconKind | null;
  isHovered: boolean;
  isLoading: boolean;
  isCreating?: boolean;
  shortcutNumber?: number | null;
  showShortcutBadge?: boolean;
  /** Keep the empty leading slot when the workspace has no active status. */
  reserveIdleStatusIndicatorSpace?: boolean;
  children?: ReactNode;
}) {
  const {
    settings: { workspaceTitleSource },
  } = useAppSettings();
  const workspaceLabel = resolveSidebarWorkspacePrimaryLabel({ workspace, workspaceTitleSource });
  const hasTitleAccessory = Boolean(scriptIconKind || workspace.prHint || hostBadge);
  const workspaceBranchTextStyle = useMemo(
    () => [
      styles.workspaceBranchText,
      hasTitleAccessory
        ? styles.workspaceBranchTextWithAccessory
        : styles.workspaceBranchTextFlexible,
      isHovered && styles.workspaceBranchTextHovered,
      isCreating && styles.workspaceBranchTextCreating,
    ],
    [hasTitleAccessory, isHovered, isCreating],
  );

  return (
    <View style={styles.workspaceRowContent}>
      <View style={styles.workspaceRowMain}>
        {leadingProjectName ? (
          <ProjectStatusIndicator
            iconDataUri={leadingProjectIconDataUri}
            displayName={leadingProjectName}
            projectViewKey={workspace.projectViewKey}
            statusBucket={workspace.statusBucket}
            loading={isLoading}
            testID={`sidebar-row-project-icon-${workspace.workspaceKey}`}
          />
        ) : (
          <WorkspaceStatusIndicator
            bucket={workspace.statusBucket}
            workspaceKind={workspace.workspaceKind}
            loading={isLoading}
            reserveIdleSpace={reserveIdleStatusIndicatorSpace}
          />
        )}
        <View style={styles.workspaceContentColumn}>
          <View style={styles.workspaceTitleRow}>
            <View style={styles.workspaceTitleLeft}>
              {workspace.prHint ? <PullRequestIcon hint={workspace.prHint} /> : null}
              {hostBadge ? (
                <HostBadge
                  serverId={hostBadge.serverId}
                  label={hostBadge.label}
                  color={hostBadge.color}
                  showLabel={hostBadge.showLabel}
                />
              ) : null}
              <Text style={workspaceBranchTextStyle} numberOfLines={1}>
                {workspaceLabel}
              </Text>
              {scriptIconKind ? <WorkspaceScriptIcon kind={scriptIconKind} /> : null}
            </View>
            <View style={sidebarWorkspaceRowStyles.rowRight}>{children}</View>
          </View>
        </View>
      </View>
      {showShortcutBadge && shortcutNumber !== null ? (
        <View style={styles.shortcutBadgeOverlay} pointerEvents="none">
          <SidebarWorkspaceShortcutBadge number={shortcutNumber} />
        </View>
      ) : null}
    </View>
  );
});

function WorkspaceScriptIcon({ kind }: { kind: SidebarWorkspaceScriptIconKind }) {
  return (
    <View
      style={styles.workspaceTitleAccessory}
      accessibilityLabel="Scripts available"
      testID={kind === "service" ? "workspace-globe-icon" : "workspace-terminal-icon"}
    >
      {kind === "service" ? (
        <ThemedGlobe size={12} uniProps={blueColorMapping} />
      ) : (
        <ThemedSquareTerminal size={12} uniProps={blueColorMapping} />
      )}
    </View>
  );
}

function WorkspaceStatusIndicator({
  bucket,
  workspaceKind,
  loading = false,
  reserveIdleSpace = true,
}: {
  bucket: SidebarWorkspaceEntry["statusBucket"];
  workspaceKind: SidebarWorkspaceEntry["workspaceKind"];
  loading?: boolean;
  reserveIdleSpace?: boolean;
}) {
  // Busy is a pulsing dot here for the same reason it is on a project icon: every status in
  // the sidebar is a dot, and a row with a project icon simply moves that dot onto the icon.
  // A row starting up and a row working are both busy, so they share the dot and differ only
  // in testID.
  if (loading) {
    return (
      <View style={styles.workspaceStatusDot} testID="workspace-status-indicator-loading">
        <PulsingStatusDot style={styles.standaloneRunningDot} />
      </View>
    );
  }

  if (shouldRenderSyncedStatusLoader({ bucket })) {
    return (
      <View style={styles.workspaceStatusDot} testID="workspace-status-indicator-running">
        <PulsingStatusDot style={styles.standaloneRunningDot} />
      </View>
    );
  }

  if (bucket === "needs_input") {
    return (
      <View style={styles.workspaceStatusDot} testID="workspace-status-indicator-needs_input">
        <ThemedCircleAlert size={14} uniProps={amberColorMapping} />
      </View>
    );
  }

  if (bucket === "attention") {
    return (
      <View style={styles.workspaceStatusDot} testID="workspace-status-indicator-attention">
        <View style={styles.standaloneStatusDot} />
      </View>
    );
  }

  if (bucket === "done") {
    // An idle row still gets a dot rather than an empty slot. Nested rows are marked as
    // workspaces by indentation alone, and with nothing in the leading slot the rail has no
    // edge to read against — a workspace carrying its own glyph starts looking like a project
    // header. The dot is muted to half opacity so it holds the rail without reporting status.
    return reserveIdleSpace ? (
      <View style={styles.workspaceStatusDot} testID="workspace-status-indicator-done">
        <View style={styles.idleStatusDot} />
      </View>
    ) : null;
  }

  let KindIcon: typeof ThemedMonitor;
  if (workspaceKind === "local_checkout") KindIcon = ThemedMonitor;
  else if (workspaceKind === "worktree") KindIcon = ThemedFolderGit2;
  else KindIcon = ThemedFolder;

  const dotColorStyle = getStatusDotColorStyle(bucket);
  const statusDotSize = isEmphasizedStatusDotBucket(bucket)
    ? EMPHASIZED_STATUS_DOT_SIZE
    : DEFAULT_STATUS_DOT_SIZE;
  const statusDotOffset =
    statusDotSize === EMPHASIZED_STATUS_DOT_SIZE
      ? EMPHASIZED_STATUS_DOT_OFFSET
      : DEFAULT_STATUS_DOT_OFFSET;
  return (
    <View style={styles.workspaceStatusDot} testID={`workspace-status-indicator-${bucket}`}>
      <KindIcon size={14} uniProps={foregroundMutedColorMapping} />
      {dotColorStyle ? (
        <StatusDotOverlay
          dotColorStyle={dotColorStyle}
          size={statusDotSize}
          offset={statusDotOffset}
        />
      ) : null}
    </View>
  );
}

function StatusDotOverlay({
  dotColorStyle,
  size,
  offset,
}: {
  dotColorStyle: ViewStyle;
  size: number;
  offset: number;
}) {
  const overlayStyle = useMemo(
    () => [
      styles.statusDotOverlay,
      dotColorStyle,
      {
        width: size,
        height: size,
        right: offset,
        bottom: offset,
      },
    ],
    [dotColorStyle, offset, size],
  );
  return <View style={overlayStyle} />;
}

function PullRequestIcon({ hint }: { hint: PrHint }) {
  const { t } = useTranslation();
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      void openExternalUrl(hint.url);
    },
    [hint.url],
  );
  const presentation = getForgePresentation(normalizeForge(hint.forge));

  const handlePressIn = useCallback((event: GestureResponderEvent) => event.stopPropagation(), []);

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={t("workspace.git.pr.accessibility.pullRequest", {
        number: hint.number,
        context: presentation.changeRequestContext,
      })}
      hitSlop={4}
      onPressIn={handlePressIn}
      onPress={handlePress}
      style={pullRequestIconStyle}
    >
      <ThemedGitPullRequest size={12} uniProps={getPrIconUniMapping(hint.state)} />
    </Pressable>
  );
}

function getPrIconUniMapping(state: PrHint["state"]) {
  switch (state) {
    case "merged":
      return purpleColorMapping;
    case "open":
      return greenColorMapping;
    case "closed":
      return redColorMapping;
  }
}

function getStatusDotColorStyle(bucket: SidebarStateBucket) {
  switch (bucket) {
    case "needs_input":
      return styles.statusDotNeedsInput;
    case "failed":
      return styles.statusDotFailed;
    case "running":
      return styles.statusDotRunning;
    case "attention":
      return styles.statusDotAttention;
    case "done":
      return null;
  }
}

const pullRequestIconStyles = StyleSheet.create(() => ({
  pressable: {
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  pressableActive: {
    opacity: 0.82,
  },
}));

export const sidebarWorkspaceRowStyles = StyleSheet.create((theme) => ({
  rowRight: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  shortcutBadge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface0,
    flexShrink: 0,
  },
  shortcutBadgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 14,
  },
  hidden: { opacity: 0 },
  trailingActionSlot: {
    position: "relative",
    minWidth: 18,
    minHeight: 20,
    flexShrink: 0,
    alignItems: "flex-end",
    justifyContent: "flex-start",
  },
  trailingActionOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
  },
  trailingActionScrim: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    width: SCRIM_WIDTH,
  },
}));

export function SidebarWorkspaceShortcutBadge({ number }: { number: number }) {
  return (
    <View style={sidebarWorkspaceRowStyles.shortcutBadge}>
      <Text style={sidebarWorkspaceRowStyles.shortcutBadgeText}>{number}</Text>
    </View>
  );
}

/**
 * What the trailing slot shows for a row. Derived in one place because three row renderers
 * share it: the two project-mode rows and the status-mode row. The rule used to be copied
 * into each of them and immediately drifted — one call site kept hiding the diff after the
 * others stopped.
 *
 * The diff survives the kebab on hover and fades under the scrim instead of blinking out.
 * Touch has no hover, so its permanent kebab still hides the diff outright rather than
 * scrimming an unhovered row whose background doesn't match the gradient.
 */
export function resolveTrailingActionVisibility({
  hasDiffStat,
  hasArchiveAction,
  isHovered,
  isTouchPlatform,
  showShortcut,
}: {
  hasDiffStat: boolean;
  hasArchiveAction: boolean;
  isHovered: boolean;
  isTouchPlatform: boolean;
  showShortcut: boolean;
}): { showDiffStat: boolean; showKebab: boolean; showScrim: boolean } {
  const showKebab = Boolean(hasArchiveAction && (isHovered || isTouchPlatform)) && !showShortcut;
  const showDiffStat = hasDiffStat && !showShortcut && (isHovered || !showKebab);
  return { showDiffStat, showKebab, showScrim: showDiffStat && showKebab };
}

export function SidebarWorkspaceTrailingActionSlot({ children }: { children: ReactNode }) {
  return <View style={sidebarWorkspaceRowStyles.trailingActionSlot}>{children}</View>;
}

export function SidebarWorkspaceTrailingActionBase({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  if (!children) return null;
  return <View style={visible ? undefined : sidebarWorkspaceRowStyles.hidden}>{children}</View>;
}

export function SidebarWorkspaceTrailingActionOverlay({
  visible,
  scrim = false,
  children,
}: {
  visible: boolean;
  /** Fade the row into the kebab when something (the diff stat) is still rendered behind it. */
  scrim?: boolean;
  children: ReactNode;
}) {
  if (!visible || !children) return null;
  return (
    <>
      {scrim ? <TrailingActionScrim /> : null}
      <View style={sidebarWorkspaceRowStyles.trailingActionOverlay}>{children}</View>
    </>
  );
}

/**
 * The row's own background, faded in from the right, sitting between the diff stat and the
 * kebab. The kebab lands on fully opaque background while the diff dissolves underneath it
 * rather than blinking out — hiding the diff outright was the old behavior and it cost a
 * visible flicker on every hover.
 *
 * Anchored to the trailing slot, which is position:relative. Wider than the slot on purpose:
 * the fade has to start before the diff stat does or the diff's left edge cuts off hard.
 */
function TrailingActionScrim() {
  // useId's output contains characters that are not legal inside url(#...) — React 19 wraps
  // ids in guillemets, React 18 in colons — and an unresolvable fill paints nothing at all.
  // Keep the per-instance uniqueness, drop everything a fragment reference can't carry.
  const gradientId = `sidebar-scrim-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <View style={sidebarWorkspaceRowStyles.trailingActionScrim} pointerEvents="none">
      <ThemedTrailingActionScrimSvg gradientId={gradientId} uniProps={scrimColorMapping} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  workspaceRowContent: {
    position: "relative",
  },
  workspaceRowMain: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    width: "100%",
  },
  workspaceContentColumn: {
    flex: 1,
    minWidth: 0,
  },
  workspaceTitleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  workspaceTitleLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  shortcutBadgeOverlay: {
    position: "absolute",
    top: 1,
    right: 0,
  },
  workspaceStatusDot: {
    position: "relative",
    width: theme.iconSize.md,
    height: 20,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  statusDotOverlay: {
    position: "absolute",
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
  },
  standaloneStatusDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.green[500],
  },
  standaloneRunningDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: getStatusDotColor({ theme, bucket: "running" }) ?? undefined,
  },
  idleStatusDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundExtraMuted,
    opacity: 0.3,
  },
  workspaceBranchText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "400",
    lineHeight: 20,
    opacity: 0.76,
    minWidth: 0,
  },
  workspaceBranchTextFlexible: {
    flex: 1,
  },
  workspaceBranchTextWithAccessory: {
    flexShrink: 1,
  },
  workspaceTitleAccessory: {
    height: 20,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  workspaceBranchTextCreating: {
    opacity: 0.92,
  },
  workspaceBranchTextHovered: {
    opacity: 1,
  },
  statusDotNeedsInput: {
    backgroundColor: theme.colors.palette.amber[500],
    borderColor: theme.colors.surface0,
  },
  statusDotFailed: {
    backgroundColor: theme.colors.palette.red[500],
    borderColor: theme.colors.surface0,
  },
  statusDotRunning: {
    backgroundColor: getStatusDotColor({ theme, bucket: "running" }) ?? undefined,
    borderColor: theme.colors.surface0,
  },
  statusDotAttention: {
    backgroundColor: theme.colors.palette.green[500],
    borderColor: theme.colors.surface0,
  },
}));
