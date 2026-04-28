import type { ViewStyle } from "react-native";
import { useUnistyles } from "react-native-unistyles";

export interface RowStateInput {
  hovered?: boolean;
  pressed?: boolean;
  selected?: boolean;
  focused?: boolean;
}

export interface RowStateStyle {
  /** Background + accent stripe for the row container. Merge onto the row's View style. */
  container: ViewStyle;
  /** 2px focus ring, applied via borderColor/borderWidth on web Pressables. */
  focusRing: ViewStyle;
}

/**
 * Single source of truth for "what does a list row look like when hovered /
 * pressed / selected / focused" across the app — channel rows, DM rows,
 * session rows, shared-workspace rows, and nav items.
 *
 * Uses the `rowHover / rowSelected / rowPressed / rowSelectedAccent / focusRing`
 * tokens so theme switching and dark/light pairing stay consistent.
 */
export function useRowStateStyle(state: RowStateInput): RowStateStyle {
  const { theme } = useUnistyles();
  const { hovered, pressed, selected, focused } = state;

  let backgroundColor: string | undefined;
  if (pressed) backgroundColor = theme.colors.rowPressed;
  else if (selected) backgroundColor = theme.colors.rowSelected;
  else if (hovered) backgroundColor = theme.colors.rowHover;

  const container: ViewStyle = {
    backgroundColor,
    ...(selected
      ? {
          borderLeftWidth: 3,
          borderLeftColor: theme.colors.rowSelectedAccent,
        }
      : {
          borderLeftWidth: 3,
          borderLeftColor: "transparent",
        }),
  };

  const focusRing: ViewStyle = focused
    ? {
        borderWidth: 2,
        borderColor: theme.colors.focusRing,
        borderRadius: 6,
      }
    : {};

  return { container, focusRing };
}
