import { StyleSheet } from "react-native-unistyles";

export const TIMELINE_CONTROL_ICON_SIZE = 20;

export const timelineControlStyles = StyleSheet.create((theme) => ({
  button: {
    width: 44,
    height: 44,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    backgroundColor: theme.colors.surface2,
    ...theme.shadow.sm,
  },
  active: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  disabled: {
    opacity: theme.opacity[50],
  },
}));
