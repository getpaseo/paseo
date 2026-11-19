import { StyleSheet } from "react-native-unistyles";

/**
 * The transcript's floating controls: scroll-to-bottom and plugin timeline buttons share this
 * style so they read as one row of controls.
 */
export const TIMELINE_CONTROL_ICON_SIZE = 16;

export const timelineControlStyles = StyleSheet.create((theme) => ({
  // The row's own background sits behind the buttons. No padding, border or shadow: when no
  // button shows, the empty row has no size and must draw nothing.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  button: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  active: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  disabled: {
    opacity: theme.opacity[50],
  },
  icon: {
    color: theme.colors.foregroundMuted,
  },
}));
