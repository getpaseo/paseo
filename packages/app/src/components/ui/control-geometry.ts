import type { StyleProp, ViewStyle } from "react-native";
import { ICON_SIZE, type Theme } from "@/styles/theme";

/**
 * Controls come in two sizes. `md` is the default and the right size almost everywhere;
 * `sm` is for tight chrome such as toolbars and nested rows.
 */
export type ControlSize = "sm" | "md";
/** Alerts are containers, not controls, so they keep their own density scale. */
export type AlertSize = "xs" | "sm" | "md" | "lg";
export type ControlInteractionPhase = "rest" | "hover" | "active";

export interface ControlInteractionState {
  hovered?: boolean;
  focused?: boolean;
  pressed?: boolean;
  open?: boolean;
  active?: boolean;
  disabled?: boolean;
}

export interface ControlInteractionStyleMap {
  controlRest: StyleProp<ViewStyle>;
  controlHover: StyleProp<ViewStyle>;
  controlActive: StyleProp<ViewStyle>;
  controlDisabled?: StyleProp<ViewStyle>;
}

const SMALL_CONTROL_HEIGHT = 28;
// The default control keeps a full touch target in the compact layout and tightens where a
// pointer drives it.
const DEFAULT_CONTROL_HEIGHT_COMPACT_LAYOUT = 44;
const DEFAULT_CONTROL_HEIGHT_WIDE_LAYOUT = 32;
export const HEADER_CONTROL_HEIGHT = 26;
const SEGMENTED_INSET = 2;
const CONTROL_FOCUS_RING_WIDTH = 2;
const CONTROL_FOCUS_RING_OFFSET = 1;
const FIELD_TEXT_LINE_HEIGHT_RATIO = 1.4;

/** A Unistyles breakpoint value: one number in the compact layout, another from `md` up. */
// A mapped type, not an interface: Unistyles checks breakpoint objects against an index
// signature, which interfaces never satisfy.
export type LayoutValue = Record<"xs" | "md", number>;

function byLayout(compact: number, wide: number): LayoutValue {
  return { xs: compact, md: wide };
}

function mapLayout(value: LayoutValue, map: (height: number) => number): LayoutValue {
  return byLayout(map(value.xs), map(value.md));
}

/**
 * The height of every button, field, and segmented control of a size. Exported so a row that
 * hosts one of those controls can size itself from the same numbers instead of guessing a
 * height the control then outgrows. `md` depends on the layout, so it only works inside a
 * Unistyles stylesheet.
 */
export const CONTROL_HEIGHTS = {
  sm: SMALL_CONTROL_HEIGHT,
  md: byLayout(DEFAULT_CONTROL_HEIGHT_COMPACT_LAYOUT, DEFAULT_CONTROL_HEIGHT_WIDE_LAYOUT),
} satisfies Record<ControlSize, number | LayoutValue>;

/** The height of a control of `size`, for code that has to compute with it outside a stylesheet. */
export function controlHeightForLayout(size: ControlSize, isCompact: boolean): number {
  const height = CONTROL_HEIGHTS[size];
  if (typeof height === "number") return height;
  return isCompact ? height.xs : height.md;
}

export const controlIconSize: Record<ControlSize, number> = {
  sm: ICON_SIZE.xs,
  md: ICON_SIZE.sm,
};

export interface SwitchGeometry {
  trackWidth: number;
  trackHeight: number;
  thumbSize: number;
  /** How far the thumb slides between off and on. */
  thumbTravel: number;
  /** The control height the switch reserves, so its row lines up with one holding a button. */
  reservedHeight: number;
}

function switchSize(trackWidth: number, trackHeight: number, thumbSize: number) {
  const inset = (trackHeight - thumbSize) / 2;
  return { trackWidth, trackHeight, thumbSize, thumbTravel: trackWidth - thumbSize - inset * 2 };
}

const SWITCH_POINTER = switchSize(34, 20, 16);
const SWITCH_TOUCH = switchSize(44, 26, 22);

/**
 * A switch follows the same two sizes as every other control. Its thumb travel feeds an
 * animation, so the size is resolved to plain numbers here instead of a stylesheet breakpoint.
 */
export function switchGeometryForLayout(size: ControlSize, isCompact: boolean): SwitchGeometry {
  const track = size === "md" && isCompact ? SWITCH_TOUCH : SWITCH_POINTER;
  return { ...track, reservedHeight: controlHeightForLayout(size, isCompact) };
}

function fieldLineHeight(fontSize: number): number {
  return Math.round(fontSize * FIELD_TEXT_LINE_HEIGHT_RATIO);
}

function fieldVerticalPadding(
  controlHeight: number,
  lineHeight: number,
  borderWidth: number,
): number {
  return (controlHeight - lineHeight - borderWidth * 2) / 2;
}

/**
 * Alert density steps. Each step's icon matches the text it leads.
 * The icon and the first text sit in one centered lead row; everything below is indented
 * by the icon slot plus its gap so it starts at the lead text's left edge. Title and
 * description use one font size; only the container gap separates them.
 */
export const ALERT_ICON_SIZE: Record<AlertSize, number> = {
  xs: ICON_SIZE.xs,
  sm: ICON_SIZE.sm,
  md: ICON_SIZE.md,
  lg: ICON_SIZE.lg,
};

function createAlertGeometry(theme: Theme) {
  function alertSize(input: {
    size: AlertSize;
    fontSize: number;
    paddingVertical: number;
    paddingHorizontal: number;
    borderRadius: number;
    iconGap: number;
    textGap: number;
  }) {
    const iconSize = ALERT_ICON_SIZE[input.size];
    return {
      container: {
        paddingVertical: input.paddingVertical,
        paddingHorizontal: input.paddingHorizontal,
        borderRadius: input.borderRadius,
        gap: input.textGap,
      },
      lead: { gap: input.iconGap },
      iconSlot: { width: iconSize },
      indent: { marginLeft: iconSize + input.iconGap },
      text: { fontSize: input.fontSize },
    };
  }

  return {
    xs: alertSize({
      size: "xs",
      fontSize: theme.fontSize.sm,
      paddingVertical: theme.spacing[2],
      paddingHorizontal: theme.spacing[3],
      borderRadius: theme.borderRadius.xl,
      iconGap: theme.spacing[2],
      textGap: 0,
    }),
    sm: alertSize({
      size: "sm",
      fontSize: theme.fontSize.base,
      paddingVertical: theme.spacing[3],
      paddingHorizontal: theme.spacing[4],
      borderRadius: theme.borderRadius["2xl"],
      iconGap: theme.spacing[3],
      textGap: theme.spacing[0.5],
    }),
    md: alertSize({
      size: "md",
      fontSize: theme.fontSize.base,
      paddingVertical: theme.spacing[4],
      paddingHorizontal: theme.spacing[6],
      borderRadius: theme.borderRadius["2xl"],
      iconGap: theme.spacing[3],
      textGap: theme.spacing[0.5],
    }),
    lg: alertSize({
      size: "lg",
      fontSize: theme.fontSize.base,
      paddingVertical: theme.spacing[6],
      paddingHorizontal: theme.spacing[8],
      borderRadius: theme.borderRadius["2xl"],
      iconGap: theme.spacing[4],
      textGap: theme.spacing[1],
    }),
  } satisfies Record<AlertSize, unknown>;
}

export function getControlInteractionPhase(
  state: ControlInteractionState,
): ControlInteractionPhase {
  if (state.disabled) {
    return "rest";
  }
  if (state.active || state.focused || state.open || state.pressed) {
    return "active";
  }
  if (state.hovered) {
    return "hover";
  }
  return "rest";
}

export function resolveControlInteractionStyles(
  styles: ControlInteractionStyleMap,
  state: ControlInteractionState,
): StyleProp<ViewStyle> {
  const phase = getControlInteractionPhase(state);
  return [
    styles.controlRest,
    phase === "hover" ? styles.controlHover : null,
    phase === "active" ? styles.controlActive : null,
    state.disabled ? styles.controlDisabled : null,
  ];
}

export function createControlGeometry(theme: Theme) {
  const controlBorderWidth = theme.borderWidth[1];
  const fieldTextSmLineHeight = fieldLineHeight(theme.fontSize.sm);
  const fieldTextMdLineHeight = fieldLineHeight(theme.fontSize.base);
  const fieldControlSm = {
    minHeight: CONTROL_HEIGHTS.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: fieldVerticalPadding(
      CONTROL_HEIGHTS.sm,
      fieldTextSmLineHeight,
      controlBorderWidth,
    ),
    borderRadius: theme.borderRadius.md,
  };
  const fieldControlMd = {
    minHeight: CONTROL_HEIGHTS.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: mapLayout(CONTROL_HEIGHTS.md, (height) =>
      fieldVerticalPadding(height, fieldTextMdLineHeight, controlBorderWidth),
    ),
    borderRadius: theme.borderRadius.lg,
  };
  const fieldTextSm = {
    fontSize: theme.fontSize.sm,
    lineHeight: fieldTextSmLineHeight,
  };
  const fieldTextMd = {
    fontSize: theme.fontSize.base,
    lineHeight: fieldTextMdLineHeight,
  };
  const alert = createAlertGeometry(theme);

  return {
    buttonSm: {
      minHeight: CONTROL_HEIGHTS.sm,
      paddingHorizontal: theme.spacing[3],
      borderRadius: theme.borderRadius.full,
    },
    buttonMd: {
      minHeight: CONTROL_HEIGHTS.md,
      paddingHorizontal: byLayout(theme.spacing[6], theme.spacing[4]),
      borderRadius: theme.borderRadius.full,
    },
    // A button with only an icon is a circle of its size's height.
    buttonIconOnlySm: { width: CONTROL_HEIGHTS.sm, paddingHorizontal: 0 },
    buttonIconOnlyMd: { width: CONTROL_HEIGHTS.md, paddingHorizontal: 0 },
    buttonTextSm: {
      fontSize: theme.fontSize.sm,
    },
    buttonTextMd: {
      fontSize: theme.fontSize.base,
    },
    alert,
    formTextInputSm: {
      ...fieldControlSm,
      ...fieldTextSm,
    },
    formTextInputMd: {
      ...fieldControlMd,
      ...fieldTextMd,
    },
    fieldControlSm,
    fieldControlMd,
    fieldTextSm,
    fieldTextMd,
    controlRest: {
      borderWidth: controlBorderWidth,
      borderColor: "transparent",
      outlineWidth: 0,
      outlineColor: "transparent",
    },
    controlHover: {
      borderColor: theme.colors.borderAccent,
    },
    controlActive: {
      borderColor: theme.colors.borderAccent,
      outlineColor: theme.colors.accent,
      outlineOffset: CONTROL_FOCUS_RING_OFFSET,
      outlineStyle: "solid" as const,
      outlineWidth: CONTROL_FOCUS_RING_WIDTH,
    },
    controlFocusRingColor: {
      outlineColor: theme.colors.accent,
    },
    controlDisabled: {
      opacity: theme.opacity[50],
    },
    segmentedContainerSm: {
      minHeight: CONTROL_HEIGHTS.sm,
      padding: 0,
    },
    segmentedContainerMd: {
      minHeight: CONTROL_HEIGHTS.md,
      padding: 0,
    },
    segmentedSegmentSm: {
      minHeight: CONTROL_HEIGHTS.sm - SEGMENTED_INSET * 2,
      paddingHorizontal: theme.spacing[2],
      borderRadius: theme.borderRadius.full,
    },
    segmentedSegmentMd: {
      minHeight: mapLayout(CONTROL_HEIGHTS.md, (height) => height - SEGMENTED_INSET * 2),
      paddingHorizontal: theme.spacing[3],
      borderRadius: theme.borderRadius.full,
    },
    segmentedLabelSm: {
      fontSize: theme.fontSize.sm,
    },
    segmentedLabelMd: {
      fontSize: theme.fontSize.base,
    },
  };
}
