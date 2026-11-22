import { StyleSheet } from "react-native-unistyles";
import { SPACING } from "@/styles/theme";
import { bySizing, controlSizingForLayout, TOUCH_TARGET } from "@/components/ui/control-sizing";

export const COMPOSER_PILL_CLEARANCE = {
  compact: SPACING[2],
  wide: 10,
} as const;
export const COMPOSER_PILL_MIN_HEIGHT = 32;
const TRACK_ACTION_HEIGHT = { touch: TOUCH_TARGET, pointer: COMPOSER_PILL_MIN_HEIGHT };

export function resolveComposerPillClearance(isCompact: boolean): number {
  return isCompact ? COMPOSER_PILL_CLEARANCE.compact : COMPOSER_PILL_CLEARANCE.wide;
}

export function resolveComposerTrackTailClearance(isCompact: boolean): number {
  const composerClearance = resolveComposerPillClearance(isCompact);
  const transcriptClearance = isCompact ? SPACING[6] : 20;
  return (
    transcriptClearance + TRACK_ACTION_HEIGHT[controlSizingForLayout(isCompact)] + composerClearance
  );
}

export function resolveComposerTrackControlClearance(isCompact: boolean): number {
  const clearance = resolveComposerPillClearance(isCompact);
  return clearance + TRACK_ACTION_HEIGHT[controlSizingForLayout(isCompact)] + clearance;
}

/** Shared visual contract for the compact pills immediately above the composer. */
export const composerPillStyles = StyleSheet.create((theme) => ({
  body: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: COMPOSER_PILL_MIN_HEIGHT,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    // Match the composer's 16px tangent point. The 32px floor prevents short labels from
    // clamping the radius and pulling the point where the curve meets the straight edge inward.
    borderRadius: theme.borderRadius["2xl"],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
  },
  bodyActive: {
    backgroundColor: theme.colors.surface2,
  },
  actionTarget: { minHeight: bySizing(TRACK_ACTION_HEIGHT) },
  label: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  labelActive: {
    color: theme.colors.foreground,
  },
}));
