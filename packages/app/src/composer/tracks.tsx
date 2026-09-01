import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  MenuRoot,
  MenuSeparator,
  MenuSurface,
  MenuTrigger,
  useMenuContext,
  type MenuTriggerState,
} from "@/components/ui/menu";
import { StatusRing } from "@/components/status-ring";
import { STATUS_RING_HALO_INSET } from "@/components/status-ring/geometry";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { COMPOSER_PILL_CLEARANCE, composerPillStyles } from "./pill-styles";

/**
 * The strip of pills where a pane's ambient trackers and plugin actions live.
 *
 * Trackers expose a count and a detail panel; plugin actions expose their own icon and text.
 * Trackers used to be stacked cards, so every one of them pushed the composer further down the
 * pane. Built-in and contributed pills share this one-line rail and its deterministic geometry
 * on every platform.
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

export interface ComposerTrackPillSegment {
  /** Leading mark — a dot, or the running ring. `null` draws the text on its own. */
  bucket: SidebarStateBucket | null;
  /** Short enough to stay on one line alongside its siblings: "1 failed", "2/7 tasks", "3". */
  text: string;
}

export interface ComposerTrackPillProps {
  /**
   * The whole pill, left to right, at most one segment per state. One segment is the common case;
   * a tracker whose children are in several states at once gives each state its own mark so none
   * of them is hidden behind the others.
   */
  segments: readonly ComposerTrackPillSegment[];
  /** Sheet header on compact. Popovers never show one. */
  panelTitle: string;
  testID: string;
  /** Spell out anything the segments abbreviate — a bare count reads as nothing out loud. */
  accessibilityLabel?: string;
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
  segments,
  panelTitle,
  testID,
  accessibilityLabel,
  children,
}: ComposerTrackPillProps): ReactElement {
  return (
    <MenuRoot compactMode="sheet">
      <ComposerTrackPillTrigger
        segments={segments}
        testID={testID}
        accessibilityLabel={accessibilityLabel ?? segments.map((segment) => segment.text).join(" ")}
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
  segments,
  testID,
  accessibilityLabel,
}: {
  segments: readonly ComposerTrackPillSegment[];
  testID: string;
  accessibilityLabel: string;
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
      <View style={styles.segments}>
        {segments.map((segment, index) => (
          <View
            key={segment.bucket ?? "plain"}
            style={styles.segment}
            testID={`${testID}-segment-${index}`}
          >
            <ComposerTrackMark bucket={segment.bucket} />
            <Text style={labelStyle} numberOfLines={1}>
              {segment.text}
            </Text>
          </View>
        ))}
      </View>
    </MenuTrigger>
  );
}

/**
 * Actions that apply to the whole panel rather than one row — bulk archive today. Still rows:
 * they live on a menu surface, and a bordered button inside a list of menu items reads as a
 * foreign object. The divider is what separates them from the list, not their chrome.
 *
 * They go above the rows because the pointer arrives from the pill below. Reaching a bulk action
 * means travelling past every row it affects, which is the right price for it, and it cannot sit
 * under a thumb that was aiming for the nearest subagent.
 */
export function ComposerTrackActions({
  children,
  /** False when the list below is empty — a divider with nothing under it separates nothing. */
  divided = true,
}: {
  children: ReactNode;
  divided?: boolean;
}): ReactElement {
  return (
    <>
      {children}
      {divided ? <MenuSeparator /> : null}
    </>
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
 * A segment's state mark. Running is the ring every other running indicator in the app uses; the
 * rest are the dot it grows from.
 *
 * Each one is sized to the glyph you can see rather than to a slot wide enough for the largest of
 * them. The mark leads the pill, so a box wider than its glyph is padding on both sides at once:
 * it holds the dot off the pill's leading edge while the label runs flush to the trailing one, and
 * it opens a gap to its own label as wide as the gap to the next segment. The ring's halo is
 * knockout for marks that sit on top of an icon, and nothing sits under this one, so it comes off
 * too — leaving every mark's visible edge on the same rail whatever state it is in.
 */
function ComposerTrackMark({ bucket }: { bucket: SidebarStateBucket | null }): ReactElement | null {
  if (!bucket) {
    return null;
  }
  if (bucket === "running") {
    return (
      <View style={styles.ringMark}>
        <StatusRing />
      </View>
    );
  }
  return <View style={dotColorStyle(bucket)} />;
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
    // Segments sit twice as far apart as a mark sits from its own text, so a count reads as
    // belonging to the mark on its left rather than to the words on its right.
    segments: {
      flexDirection: "row",
      alignItems: "center",
      flexShrink: 1,
      minWidth: 0,
      gap: theme.spacing[4],
    },
    segment: {
      flexDirection: "row",
      alignItems: "center",
      flexShrink: 1,
      minWidth: 0,
      gap: theme.spacing[2],
    },
    // Trims the ring's halo so the circle you can see is the box, like the dot's box is the dot.
    ringMark: {
      margin: -STATUS_RING_HALO_INSET,
    },
    dotNeedsInput: statusDot("needs_input"),
    dotFailed: statusDot("failed"),
    dotAttention: statusDot("attention"),
    dotDone: statusDot("done"),
  };
});
