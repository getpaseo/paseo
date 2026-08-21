import type { StyleProp, ViewStyle } from "react-native";
import { ICON_SIZE, type Theme } from "@/styles/theme";

export type ButtonControlSize = "xs" | "sm" | "md" | "lg";
export type FieldControlSize = "sm" | "md";
export type SegmentedControlSize = "xs" | "sm" | "md";
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

const TIGHT_CONTROL_HEIGHT = 28;
const COMPACT_CONTROL_HEIGHT = 32;
const FIELD_CONTROL_HEIGHT = 44;
const SEGMENTED_TIGHT_INSET = 2;
const SEGMENTED_COMPACT_INSET = 2;
const SEGMENTED_FIELD_INSET = 3;
const SWITCH_TRACK_WIDTH = 34;
const SWITCH_TRACK_HEIGHT = 20;
const SWITCH_THUMB_SIZE = 16;
const CONTROL_FOCUS_RING_WIDTH = 2;
const CONTROL_FOCUS_RING_OFFSET = 1;
const CONTROL_CENTER_JUSTIFY_CONTENT = "center";
const FIELD_TEXT_LINE_HEIGHT_RATIO = 1.4;

/**
 * The three control heights every button, field, and segmented control is built from.
 * Exported so a row that hosts one of those controls can size itself from the same
 * numbers instead of guessing a height the control then outgrows.
 */
export const CONTROL_HEIGHTS = {
  tight: TIGHT_CONTROL_HEIGHT,
  compact: COMPACT_CONTROL_HEIGHT,
  field: FIELD_CONTROL_HEIGHT,
};

export const buttonControlHeight: Record<ButtonControlSize, number> = {
  xs: CONTROL_HEIGHTS.tight,
  sm: CONTROL_HEIGHTS.compact,
  md: CONTROL_HEIGHTS.field,
  lg: CONTROL_HEIGHTS.field,
};

export const buttonIconSize: Record<ButtonControlSize, number> = {
  xs: ICON_SIZE.xs,
  sm: ICON_SIZE.sm,
  md: ICON_SIZE.md,
  lg: ICON_SIZE.lg,
};

export const segmentedIconSize: Record<SegmentedControlSize, number> = {
  xs: ICON_SIZE.xs,
  sm: ICON_SIZE.sm,
  md: ICON_SIZE.md,
};

export const switchGeometry = {
  trackWidth: SWITCH_TRACK_WIDTH,
  trackHeight: SWITCH_TRACK_HEIGHT,
  thumbSize: SWITCH_THUMB_SIZE,
  thumbTravel: SWITCH_TRACK_WIDTH - SWITCH_THUMB_SIZE - (SWITCH_TRACK_HEIGHT - SWITCH_THUMB_SIZE),
};

function fieldLineHeight(fontSize: number): number {
  return Math.round(fontSize * FIELD_TEXT_LINE_HEIGHT_RATIO);
}

function fieldVerticalPadding(controlHeight: number, lineHeight: number): number {
  return (controlHeight - lineHeight) / 2;
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
  const fieldTextSmLineHeight = fieldLineHeight(theme.fontSize.base);
  const fieldTextMdLineHeight = fieldLineHeight(theme.fontSize.base);
  const fieldControlSm = {
    minHeight: CONTROL_HEIGHTS.compact,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: fieldVerticalPadding(CONTROL_HEIGHTS.compact, fieldTextSmLineHeight),
    borderRadius: theme.borderRadius.md,
  };
  const fieldControlMd = {
    minHeight: CONTROL_HEIGHTS.field,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: fieldVerticalPadding(CONTROL_HEIGHTS.field, fieldTextMdLineHeight),
    borderRadius: theme.borderRadius.lg,
  };
  const fieldTextSm = {
    fontSize: theme.fontSize.base,
    lineHeight: fieldTextSmLineHeight,
  };
  const fieldTextMd = {
    fontSize: theme.fontSize.base,
    lineHeight: fieldTextMdLineHeight,
  };
  const switchControl = {
    minHeight: CONTROL_HEIGHTS.compact,
    justifyContent: CONTROL_CENTER_JUSTIFY_CONTENT,
  } satisfies { minHeight: number; justifyContent: "center" };

  return {
    buttonXs: {
      minHeight: buttonControlHeight.xs,
      paddingHorizontal: theme.spacing[3],
      borderRadius: theme.borderRadius.md,
    },
    buttonSm: {
      minHeight: buttonControlHeight.sm,
      paddingHorizontal: theme.spacing[3],
      borderRadius: theme.borderRadius.md,
    },
    buttonMd: {
      minHeight: buttonControlHeight.md,
      paddingHorizontal: theme.spacing[4],
      borderRadius: theme.borderRadius.lg,
    },
    buttonLg: {
      minHeight: buttonControlHeight.lg,
      paddingHorizontal: theme.spacing[6],
      borderRadius: theme.borderRadius.xl,
    },
    buttonText: {
      fontSize: theme.fontSize.base,
    },
    buttonTextXs: {
      fontSize: theme.fontSize.sm,
    },
    formTextInputSm: {
      ...fieldControlSm,
      ...fieldTextSm,
    },
    formTextInputMd: {
      ...fieldControlMd,
      ...fieldTextMd,
    },
    formTextInput: {
      ...fieldControlMd,
      ...fieldTextMd,
    },
    fieldControlSm,
    fieldControlMd,
    fieldTextSm,
    fieldTextMd,
    controlRest: {
      borderWidth: theme.borderWidth[1],
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
    switchControl,
    segmentedContainerXs: {
      minHeight: CONTROL_HEIGHTS.tight,
      padding: 0,
    },
    segmentedContainerSm: {
      minHeight: CONTROL_HEIGHTS.compact,
      padding: 0,
    },
    segmentedContainerMd: {
      minHeight: CONTROL_HEIGHTS.field,
      padding: 0,
    },
    segmentedSegmentXs: {
      minHeight: CONTROL_HEIGHTS.tight - SEGMENTED_TIGHT_INSET * 2,
      paddingHorizontal: theme.spacing[2],
      borderRadius: theme.borderRadius.md,
    },
    segmentedSegmentSm: {
      minHeight: CONTROL_HEIGHTS.compact - SEGMENTED_COMPACT_INSET * 2,
      paddingHorizontal: theme.spacing[2],
      borderRadius: theme.borderRadius.md,
    },
    segmentedSegmentMd: {
      minHeight: CONTROL_HEIGHTS.field - SEGMENTED_FIELD_INSET * 2,
      paddingHorizontal: theme.spacing[3],
      borderRadius: theme.borderRadius.lg,
    },
    segmentedLabelXs: {
      fontSize: theme.fontSize.sm,
    },
    segmentedLabelSm: {
      fontSize: theme.fontSize.base,
    },
    segmentedLabelMd: {
      fontSize: theme.fontSize.base,
    },
  };
}
