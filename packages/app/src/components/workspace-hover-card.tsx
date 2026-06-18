import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
} from "react";
import { Dimensions, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { FadeIn, FadeOut } from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  Check,
  CircleCheck,
  CircleDot,
  CircleX,
  Copy,
  ExternalLink,
  Folder,
  GitBranch,
} from "lucide-react-native";
import { GitHubIcon } from "@/components/icons/github-icon";
import type { Theme } from "@/styles/theme";
import { DiffStat } from "@/components/diff-stat";
import { Pressable } from "react-native";
import type { GestureResponderEvent } from "react-native";
import { Portal } from "@gorhom/portal";
import { useBottomSheetModalInternal } from "@gorhom/bottom-sheet";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { PrHint } from "@/git/use-pr-status-query";
import { openExternalUrl } from "@/utils/open-external-url";
import { shortenPath } from "@/utils/shorten-path";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { PrBadge } from "@/components/sidebar-workspace-list";
import { useHoverSafeZone } from "@/hooks/use-hover-safe-zone";
import { useIsCompactFormFactor } from "@/constants/layout";
import { FloatingSurface } from "@/components/ui/floating";
import { isWeb } from "@/constants/platform";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function measureElement(element: View): Promise<Rect> {
  return new Promise((resolve) => {
    element.measureInWindow((x, y, width, height) => {
      resolve({ x, y, width, height });
    });
  });
}

function computeHoverCardPosition({
  triggerRect,
  contentSize,
  displayArea,
  offset,
}: {
  triggerRect: Rect;
  contentSize: { width: number; height: number };
  displayArea: Rect;
  offset: number;
}): { x: number; y: number } {
  let x = triggerRect.x + triggerRect.width + offset;
  let y = triggerRect.y;

  // If it overflows right, try left
  if (x + contentSize.width > displayArea.width - 8) {
    x = triggerRect.x - contentSize.width - offset;
  }

  // Constrain to screen
  const padding = 8;
  x = Math.max(padding, Math.min(displayArea.width - contentSize.width - padding, x));
  y = Math.max(
    displayArea.y + padding,
    Math.min(displayArea.y + displayArea.height - contentSize.height - padding, y),
  );

  return { x, y };
}

const HOVER_GRACE_MS = 100;
const HOVER_CARD_WIDTH = 260;

interface WorkspaceHoverCardProps {
  workspace: SidebarWorkspaceEntry;
  prHint: PrHint | null;
  isDragging: boolean;
}

export function WorkspaceHoverCard({
  workspace,
  prHint,
  isDragging,
  children,
}: PropsWithChildren<WorkspaceHoverCardProps>): ReactNode {
  const isCompact = useIsCompactFormFactor();

  if (!isWeb || isCompact) {
    return children;
  }

  return (
    <WorkspaceHoverCardDesktop workspace={workspace} prHint={prHint} isDragging={isDragging}>
      {children}
    </WorkspaceHoverCardDesktop>
  );
}

function WorkspaceHoverCardDesktop({
  workspace,
  prHint,
  isDragging,
  children,
}: PropsWithChildren<WorkspaceHoverCardProps>): ReactElement {
  const triggerRef = useRef<View>(null);
  const contentRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerHoveredRef = useRef(false);

  const clearGraceTimer = useCallback(() => {
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    if (graceTimerRef.current) return;
    graceTimerRef.current = setTimeout(() => {
      graceTimerRef.current = null;
      setOpen(false);
    }, HOVER_GRACE_MS);
  }, []);

  const handleTriggerEnter = useCallback(() => {
    triggerHoveredRef.current = true;
    clearGraceTimer();
    if (!isDragging) {
      setOpen(true);
    }
  }, [clearGraceTimer, isDragging]);

  const handleTriggerLeave = useCallback(() => {
    triggerHoveredRef.current = false;
    scheduleClose();
  }, [scheduleClose]);

  // While open, the safe zone covers trigger + content + the bridge between
  // them. Close only fires when the pointer leaves the safe zone; re-entering
  // it (including the bridge) cancels the pending close.
  useHoverSafeZone({
    enabled: open,
    triggerRef,
    contentRef,
    onEnterSafeZone: clearGraceTimer,
    onLeaveSafeZone: scheduleClose,
  });

  // Close when drag starts
  useEffect(() => {
    if (isDragging) {
      clearGraceTimer();
      setOpen(false);
    }
  }, [isDragging, clearGraceTimer]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearGraceTimer();
    };
  }, [clearGraceTimer]);

  return (
    <View
      ref={triggerRef}
      collapsable={false}
      onPointerEnter={handleTriggerEnter}
      onPointerLeave={handleTriggerLeave}
    >
      {children}
      {open ? (
        <WorkspaceHoverCardContent
          workspace={workspace}
          prHint={prHint}
          triggerRef={triggerRef}
          contentRef={contentRef}
        />
      ) : null}
    </View>
  );
}

function WorkspaceHoverCardContent({
  workspace,
  prHint,
  triggerRef,
  contentRef,
}: {
  workspace: SidebarWorkspaceEntry;
  prHint: PrHint | null;
  triggerRef: React.RefObject<View | null>;
  contentRef: React.RefObject<View | null>;
}): ReactElement | null {
  const { t } = useTranslation();
  const cwdDisplay = shortenPath(workspace.workspaceDirectory);
  const bottomSheetInternal = useBottomSheetModalInternal(true);
  const [triggerRect, setTriggerRect] = useState<Rect | null>(null);
  const [contentSize, setContentSize] = useState<{ width: number; height: number } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

  // Measure trigger — same pattern as tooltip.tsx
  useEffect(() => {
    if (!triggerRef.current) return;

    let cancelled = false;
    measureElement(triggerRef.current).then((rect) => {
      if (cancelled) return;
      setTriggerRect(rect);
      return;
    });

    return () => {
      cancelled = true;
    };
  }, [triggerRef]);

  // Compute position when both measurements are available
  useEffect(() => {
    if (!triggerRect || !contentSize) return;
    const { width: screenWidth, height: screenHeight } = Dimensions.get("window");
    const displayArea = { x: 0, y: 0, width: screenWidth, height: screenHeight };
    const result = computeHoverCardPosition({
      triggerRect,
      contentSize,
      displayArea,
      offset: 4,
    });
    setPosition(result);
  }, [triggerRect, contentSize]);

  const handleLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number; height: number } } }) => {
      const { width, height } = event.nativeEvent.layout;
      setContentSize({ width, height });
    },
    [],
  );

  const frameStyle = useMemo(
    () => ({
      position: "absolute" as const,
      top: position?.y ?? -9999,
      left: position?.x ?? -9999,
    }),
    [position?.x, position?.y],
  );

  return (
    <Portal hostName={bottomSheetInternal?.hostName}>
      <View pointerEvents="box-none" style={styles.portalOverlay}>
        <FloatingSurface
          ref={contentRef}
          entering={FadeIn.duration(80)}
          exiting={FadeOut.duration(80)}
          collapsable={false}
          onLayout={handleLayout}
          accessibilityRole="menu"
          accessibilityLabel={t("workspace.hoverCard.scriptsAccessibility")}
          testID="workspace-hover-card"
          style={styles.card}
          frameStyle={frameStyle}
        >
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle} testID="hover-card-workspace-name">
              {workspace.name}
            </Text>
          </View>
          {workspace.currentBranch ? (
            <CopyableInfoRow
              icon={ThemedGitBranch}
              value={workspace.currentBranch}
              copyValue={workspace.currentBranch}
              copyLabel={t("workspace.hoverCard.copyBranchName")}
              testID="hover-card-workspace-branch"
            />
          ) : null}
          {cwdDisplay ? (
            <CopyableInfoRow
              icon={ThemedFolder}
              value={cwdDisplay}
              copyValue={workspace.workspaceDirectory ?? ""}
              copyLabel={t("workspace.hoverCard.copyPath")}
              testID="hover-card-workspace-cwd"
            />
          ) : null}
          {prHint || workspace.diffStat ? (
            <View style={styles.cardMetaRow}>
              {workspace.diffStat ? (
                <DiffStat
                  additions={workspace.diffStat.additions}
                  deletions={workspace.diffStat.deletions}
                />
              ) : null}
              {prHint ? <PrBadge hint={prHint} /> : null}
            </View>
          ) : null}
          {prHint?.checks && prHint.checks.length > 0 ? (
            <>
              <View style={styles.separator} />
              <ChecksSummaryPressable checks={prHint.checks} url={prHint.url} />
            </>
          ) : null}
        </FloatingSurface>
      </View>
    </Portal>
  );
}

const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedFolder = withUnistyles(Folder);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedGitHubIcon = withUnistyles(GitHubIcon);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCircleX = withUnistyles(CircleX);
const ThemedCopy = withUnistyles(Copy);
const ThemedCheck = withUnistyles(Check);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successColorMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const warningColorMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const dangerColorMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

function CopyableInfoRow({
  icon: Icon,
  value,
  copyValue,
  copyLabel,
  testID,
}: {
  icon: React.ComponentType<React.ComponentProps<typeof ThemedGitBranch>>;
  value: string;
  copyValue: string;
  copyLabel: string;
  testID: string;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [copied, setCopied] = useState(false);

  const handlePressIn = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
  }, []);

  const handlePress = useCallback(() => {
    void copyToClipboard(copyValue);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  }, [copyValue]);

  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);

  let iconUniProps = foregroundMutedColorMapping;
  if (copied || isHovered) {
    iconUniProps = foregroundColorMapping;
  }
  const textStyle = copied || isHovered ? cardInfoTextHoveredCombined : styles.cardInfoText;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copyLabel}
      style={styles.cardInfoRow}
      hitSlop={4}
      onPressIn={handlePressIn}
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
    >
      {(() => {
        if (copied) {
          return <ThemedCheck size={12} uniProps={iconUniProps} />;
        }
        if (isHovered) {
          return <ThemedCopy size={12} uniProps={iconUniProps} />;
        }
        return <Icon size={12} uniProps={iconUniProps} />;
      })()}
      <Text style={textStyle} numberOfLines={1} testID={testID}>
        {value}
      </Text>
    </Pressable>
  );
}

function getChecksSummaryCounts(checks: NonNullable<PrHint["checks"]>) {
  return checks.reduce(
    (counts, check) => {
      if (check.status === "success") counts.passed += 1;
      else if (check.status === "failure") counts.failed += 1;
      else if (check.status !== "skipped" && check.status !== "cancelled") counts.pending += 1;
      return counts;
    },
    { passed: 0, failed: 0, pending: 0 },
  );
}

function ChecksSummaryPill({
  count,
  kind,
}: {
  count: number;
  kind: "passed" | "failed" | "pending";
}) {
  if (count === 0) return null;

  if (kind === "passed") {
    return (
      <View style={styles.checksSummaryPill}>
        <ThemedCircleCheck size={12} uniProps={successColorMapping} />
        <Text style={styles.checksStatusTextPassed}>{count}</Text>
      </View>
    );
  }

  if (kind === "failed") {
    return (
      <View style={styles.checksSummaryPill}>
        <ThemedCircleX size={12} uniProps={dangerColorMapping} />
        <Text style={styles.checksStatusTextFailed}>{count}</Text>
      </View>
    );
  }

  return (
    <View style={styles.checksSummaryPill}>
      <ThemedCircleDot size={12} uniProps={warningColorMapping} />
      <Text style={styles.checksStatusTextPending}>{count}</Text>
    </View>
  );
}

function ChecksSummaryContent({
  checks,
  hovered,
}: {
  checks: NonNullable<PrHint["checks"]>;
  hovered: boolean;
}) {
  const { t } = useTranslation();
  const { passed, failed, pending } = getChecksSummaryCounts(checks);

  const labelStyle = hovered ? checksSummaryLabelHoveredCombined : styles.checksSummaryLabel;
  const iconUniProps = hovered ? foregroundColorMapping : foregroundMutedColorMapping;

  return (
    <>
      {hovered ? (
        <ThemedExternalLink size={12} uniProps={iconUniProps} />
      ) : (
        <ThemedGitHubIcon size={12} uniProps={iconUniProps} />
      )}
      <Text style={labelStyle}>{t("workspace.git.pr.sections.checks")}</Text>
      <View style={styles.checksSummaryCounts}>
        <ChecksSummaryPill count={passed} kind="passed" />
        <ChecksSummaryPill count={failed} kind="failed" />
        <ChecksSummaryPill count={pending} kind="pending" />
      </View>
    </>
  );
}

function ChecksSummaryPressable({
  checks,
  url,
}: {
  checks: NonNullable<PrHint["checks"]>;
  url: string;
}) {
  const handlePress = useCallback(() => {
    void openExternalUrl(`${url}/checks`);
  }, [url]);

  const renderChildren = useCallback(
    ({ hovered }: { pressed: boolean; hovered?: boolean }) => (
      <ChecksSummaryContent checks={checks} hovered={Boolean(hovered)} />
    ),
    [checks],
  );

  return (
    <Pressable style={checksSummaryPressableStyle} onPress={handlePress}>
      {renderChildren}
    </Pressable>
  );
}

function checksSummaryPressableStyle({ hovered = false }: { pressed: boolean; hovered?: boolean }) {
  return [styles.checksSummaryRow, hovered && styles.listRowHovered];
}

const styles = StyleSheet.create((theme) => ({
  portalOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1000,
  },
  card: {
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    paddingTop: theme.spacing[2],
    width: HOVER_CARD_WIDTH,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
    zIndex: 1000,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    flex: 1,
    minWidth: 0,
  },
  cardMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  cardInfoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  cardInfoText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
  cardInfoTextHovered: {
    color: theme.colors.foreground,
  },
  separator: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  listRowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  checksSummaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 6,
    minHeight: 28,
  },
  checksSummaryLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  checksSummaryLabelHovered: {
    color: theme.colors.foreground,
  },
  checksSummaryCounts: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    justifyContent: "flex-end",
  },
  checksSummaryPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  checksStatusTextFailed: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusDanger,
  },
  checksStatusTextPending: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusWarning,
  },
  checksStatusTextPassed: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusSuccess,
  },
}));

const checksSummaryLabelHoveredCombined = [
  styles.checksSummaryLabel,
  styles.checksSummaryLabelHovered,
];

const cardInfoTextHoveredCombined = [styles.cardInfoText, styles.cardInfoTextHovered];
