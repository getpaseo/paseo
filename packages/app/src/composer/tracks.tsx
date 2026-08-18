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
import { StatusRing } from "@/components/status-ring";
import { STATUS_RING_FRAME_SIZE } from "@/components/status-ring/geometry";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { COMPOSER_PILL_CLEARANCE, composerPillStyles } from "./pill-styles";

/**
 * The strip of pills where a pane's ambient trackers live — subagents and tasks today.
 *
 * Everything in it is a pill: a count you can read without opening anything, and a panel behind
 * it for the detail. Trackers used to be stacked cards, so every one of them pushed the composer
 * further down the pane. The bar has at most one subagent pill and one task pill, so it remains
 * one line and has deterministic geometry on every platform.
 *
 * The bar floats over the transcript with no background, so content remains visible underneath.
 * Its host gives the scroll viewport a small bottom inset only when the bar exists; that keeps
 * the final footer clear without turning the overlay into a layout band.
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
  /** Drawn as a leading mark — a dot, or the running ring. `null` leaves the pill text-only. */
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
      composerPillStyles.body,
      (hovered || pressed || isOpen) && composerPillStyles.bodyActive,
    ],
    [],
  );
  const labelStyle = useMemo(
    () => [composerPillStyles.label, open && composerPillStyles.labelActive],
    [open],
  );

  return (
    <MenuTrigger
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      {...ariaExpandedProps}
      style={pillStyle}
    >
      <ComposerTrackMark bucket={statusBucket} />
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
  /**
   * Dismiss the panel when this row is chosen. Same name, same default as `MenuItem`, because it
   * is the same decision: a row that navigates away is done with the panel, a row whose result
   * lands inside the panel is not.
   */
  closeOnSelect?: boolean;
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
 *
 * A press is a menu selection, not a bare callback: the panel is a menu surface, so dismissal —
 * and on iOS the wait for UIKit to finish tearing the sheet down before the action runs — belongs
 * to the engine that opened it. The row only decides whether choosing it ends the panel.
 */
export function ComposerTrackRow({
  children,
  onPress,
  closeOnSelect = true,
  disabled = false,
  accessibilityLabel,
  testID,
}: ComposerTrackRowProps): ReactElement {
  const { selectItem } = useMenuContext("ComposerTrackRow");
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const handleSelect = useCallback(
    () => selectItem(onPress, closeOnSelect),
    [closeOnSelect, onPress, selectItem],
  );

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
        onPress={handleSelect}
      >
        {renderPressed}
      </Pressable>
    </View>
  );
}

/**
 * The pill's leading state mark. Running is the ring every other running indicator in the app
 * uses; the rest are the dot it grows from.
 */
function ComposerTrackMark({ bucket }: { bucket: SidebarStateBucket | null }): ReactElement | null {
  if (!bucket) {
    return null;
  }
  return (
    <View style={styles.mark}>
      {bucket === "running" ? <StatusRing /> : <View style={dotColorStyle(bucket)} />}
    </View>
  );
}

function dotColorStyle(bucket: Exclude<SidebarStateBucket, "running">) {
  switch (bucket) {
    case "needs_input":
      return styles.dotNeedsInput;
    case "failed":
      return styles.dotFailed;
    case "attention":
      return styles.dotAttention;
    case "done":
      return styles.dotDone;
  }
}

const styles = StyleSheet.create((theme) => {
  // Colours come from the one bucket-to-colour map so the pill cannot drift from the status dots
  // everywhere else, and are baked into each variant so the style prop stays a stable object.
  const statusDot = (bucket: Exclude<SidebarStateBucket, "running">) => ({
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: getStatusDotColor({ theme, bucket, showDoneAsInactive: true }) ?? undefined,
  });

  return {
    bar: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: "center",
      paddingHorizontal: theme.spacing[4],
      paddingBottom: {
        xs: COMPOSER_PILL_CLEARANCE.compact,
        md: COMPOSER_PILL_CLEARANCE.wide,
      },
    },
    track: {
      width: "100%",
      maxWidth: MAX_CONTENT_WIDTH,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1],
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
    // Sized for the widest mark that can land in it, which is the ring rather than the dot. The
    // slot is the same width whatever the state, so the label does not step sideways when the last
    // child stops running.
    mark: {
      width: STATUS_RING_FRAME_SIZE,
      height: STATUS_RING_FRAME_SIZE,
      alignItems: "center",
      justifyContent: "center",
    },
    dotNeedsInput: statusDot("needs_input"),
    dotFailed: statusDot("failed"),
    dotAttention: statusDot("attention"),
    dotDone: statusDot("done"),
  };
});
