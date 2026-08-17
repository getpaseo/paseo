import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  MenuRoot,
  MenuSurface,
  MenuTrigger,
  useMenuContext,
  type MenuTriggerState,
} from "@/components/ui/menu";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

/**
 * The strip of pills where a pane's ambient trackers live — subagents and tasks today.
 *
 * Everything in it is a pill: a count you can read without opening anything, and a panel behind
 * it for the detail. Trackers used to be stacked cards, so every one of them pushed the composer
 * further down the pane; a row of pills costs one line no matter how many there are.
 *
 * **Mount it in a container that spans the transcript.** The bar pins itself to that container's
 * bottom edge and paints over it, with no background of its own and `pointerEvents="box-none"`
 * so the gaps between pills still belong to the timeline scrolling underneath. Absolute, not in
 * flow: in flow it reserves a strip the transcript cannot use, which is the band this replaced.
 *
 * It stays a child of the transcript rather than a sibling floating above the composer because
 * on Android a view outside its parent's bounds paints but takes no touches — see
 * docs/floating-panels.md — and every pill here is pressable.
 */
export function ComposerTrackBar({ children }: { children: ReactNode }): ReactElement {
  return (
    <View style={styles.bar} pointerEvents="box-none">
      <View style={styles.track} pointerEvents="box-none">
        {children}
      </View>
    </View>
  );
}

export interface ComposerTrackPillProps {
  /** The whole pill, and short enough to stay on one line: "3 subagents", "2/7 tasks". */
  label: string;
  /** Sheet header on compact. Popovers never show one. */
  panelTitle: string;
  testID: string;
  accessibilityLabel?: string;
  /** Drawn as a leading dot. `null` leaves the pill text-only. */
  statusBucket?: SidebarStateBucket | null;
  /** Panel body. Rendered into a popover on wide screens and a sheet on compact ones. */
  children: ReactNode;
}

/**
 * Size of the panel, not the pill: the pill is as wide as its label, the panel is not. The
 * ceiling is generous because the rows carry real content — a subagent's task description, a
 * task's active form — and there is nothing above the composer competing for the space. The
 * surface still shrinks to its content and clamps to the viewport.
 */
const PANEL_MIN_WIDTH = 280;
const PANEL_MAX_WIDTH = 620;
const PANEL_MAX_HEIGHT = 440;
/**
 * Gap between the pill and its panel. Wider than a dropdown's, because the panel is not a menu
 * hanging off a control — it is a surface parked over the composer, and it needs to read as
 * separate from the pill that opened it.
 */
const PANEL_OFFSET = 12;

export function ComposerTrackPill({
  label,
  panelTitle,
  testID,
  accessibilityLabel,
  statusBucket = null,
  children,
}: ComposerTrackPillProps): ReactElement {
  return (
    <MenuRoot compactMode="sheet">
      <ComposerTrackPillTrigger
        label={label}
        testID={testID}
        accessibilityLabel={accessibilityLabel ?? label}
        statusBucket={statusBucket}
      />
      <MenuSurface
        side="top"
        align="start"
        offset={PANEL_OFFSET}
        sheetTitle={panelTitle}
        minWidth={PANEL_MIN_WIDTH}
        maxWidth={PANEL_MAX_WIDTH}
        maxHeight={PANEL_MAX_HEIGHT}
        scrollable
        testID={`${testID}-panel`}
      >
        {children}
      </MenuSurface>
    </MenuRoot>
  );
}

function ComposerTrackPillTrigger({
  label,
  testID,
  accessibilityLabel,
  statusBucket,
}: {
  label: string;
  testID: string;
  accessibilityLabel: string;
  statusBucket: SidebarStateBucket | null;
}): ReactElement {
  const { open } = useMenuContext("ComposerTrackPill");
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  // React Native Web does not map `accessibilityState.expanded` to `aria-expanded`, so the web
  // attribute is set by hand — the same workaround header toggles use.
  const ariaExpandedProps = isWeb ? { "aria-expanded": open } : null;
  const pillStyle = useCallback(
    ({ hovered, pressed, open: isOpen }: MenuTriggerState) => [
      styles.pill,
      (hovered || pressed || isOpen) && styles.pillActive,
    ],
    [],
  );
  const labelStyle = useMemo(() => [styles.pillLabel, open && styles.pillLabelActive], [open]);

  return (
    <MenuTrigger
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      {...ariaExpandedProps}
      style={pillStyle}
    >
      <ComposerTrackDot bucket={statusBucket} />
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
    </MenuTrigger>
  );
}

export interface ComposerTrackRowProps {
  /** A function child receives the row's own hover/press state, for hover-revealed actions. */
  children: ReactNode | ((state: { active: boolean }) => ReactNode);
  /** Rows that open something are pressable and fill on press or hover. A read-only row is not. */
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

/**
 * One line in a track panel. Every track uses it, so a subagent and a task sit on the same rail
 * and the same rhythm however different their contents are — the panels are one surface family,
 * not one design per tracker.
 *
 * Hover lives on the outer plain View and press on the inner Pressable, per docs/hover.md: rows
 * carry action buttons, and a Pressable tracking its own hover fights every Pressable inside it.
 */
export function ComposerTrackRow({
  children,
  onPress,
  disabled = false,
  accessibilityLabel,
  testID,
}: ComposerTrackRowProps): ReactElement {
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);

  const renderRow = useCallback(
    (active: boolean) => (
      <View style={active ? styles.rowActive : styles.row}>
        {typeof children === "function" ? children({ active }) : children}
      </View>
    ),
    [children],
  );
  const renderPressed = useCallback(
    ({ pressed }: { pressed: boolean }) => renderRow(hovered || pressed),
    [hovered, renderRow],
  );

  if (!onPress) {
    return <View accessibilityLabel={accessibilityLabel}>{renderRow(false)}</View>;
  }

  return (
    <View onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        testID={testID}
        disabled={disabled}
        onPress={onPress}
      >
        {renderPressed}
      </Pressable>
    </View>
  );
}

function ComposerTrackDot({ bucket }: { bucket: SidebarStateBucket | null }): ReactElement | null {
  const colorStyle = bucket ? dotColorStyle(bucket) : null;
  const dotStyle = useMemo(() => [styles.dot, colorStyle], [colorStyle]);
  if (!colorStyle) {
    return null;
  }
  return <View style={dotStyle} />;
}

function dotColorStyle(bucket: SidebarStateBucket) {
  switch (bucket) {
    case "needs_input":
      return styles.dotNeedsInput;
    case "failed":
      return styles.dotFailed;
    case "running":
      return styles.dotRunning;
    case "attention":
      return styles.dotAttention;
    case "done":
      return styles.dotDone;
  }
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  track: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    marginBottom: theme.spacing[2],
    // One step inside the composer's corner, not a stadium: the pills sit directly on top of it
    // and read as part of the same stack. See composer/input/input.tsx `inputWrapper`.
    borderRadius: theme.borderRadius.xl,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  pillActive: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.borderAccent,
  },
  pillLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  pillLabelActive: {
    color: theme.colors.foreground,
  },
  // The rail every panel row sits on: inset from the panel edge so the fill is a rounded block
  // inside it, and tall enough that revealing an action button cannot resize the row.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 32,
    marginHorizontal: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  rowActive: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 32,
    marginHorizontal: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  dot: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
  },
  dotNeedsInput: {
    backgroundColor: theme.colors.statusDotWarning,
  },
  dotFailed: {
    backgroundColor: theme.colors.statusDotDanger,
  },
  dotRunning: {
    backgroundColor: theme.colors.statusDotRunning,
  },
  dotAttention: {
    backgroundColor: theme.colors.statusDotSuccess,
  },
  dotDone: {
    backgroundColor: theme.colors.border,
  },
}));
