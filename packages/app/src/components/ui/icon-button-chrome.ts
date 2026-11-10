import { createContext, useCallback, useContext } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  bySizing,
  controlSizingForLayout,
  ICON_BUTTON_SIZES,
  TOUCH_ICON_SIZE,
  type SizingValue,
} from "@/components/ui/control-geometry";
import { ICON_SIZE } from "@/styles/theme";

export { extraMutedIconColorMapping, mutedIconColorMapping } from "@/components/ui/icon-color";

export type IconButtonChromeSize = "large" | "small";

// Touch-sized, every icon button is one target with one glyph size.
const GLYPH_SIZES = {
  large: { touch: TOUCH_ICON_SIZE.md, pointer: ICON_SIZE.md },
  small: { touch: TOUCH_ICON_SIZE.md, pointer: ICON_SIZE.sm },
} satisfies Record<IconButtonChromeSize, SizingValue>;

export interface IconButtonChromeState {
  hovered?: boolean;
  pressed?: boolean;
  open?: boolean;
  active?: boolean;
}

function resolveIconButtonFrame(size: IconButtonChromeSize, compact: boolean) {
  if (size === "large") return styles.large;
  return controlSizingForLayout(compact) === "touch" ? styles.smallTouch : styles.small;
}

interface IconButtonChromeOptions {
  size: IconButtonChromeSize;
  state?: IconButtonChromeState;
  compact?: boolean;
  disabled?: boolean;
  /** A circular hitbox and highlight, for buttons inside a pill-shaped container. */
  round?: boolean;
  style?: StyleProp<ViewStyle>;
}

const IconButtonChromeContext = createContext<"default" | "header-island">("default");

/** A container owns the chrome of its icon actions, including custom menu and badge triggers. */
export const IconButtonChromeProvider = IconButtonChromeContext.Provider;

/** The same state callback works with Pressable, TooltipTrigger, and DropdownMenuTrigger. */
export function useIconButtonChromeStyle({
  size,
  compact,
  disabled,
  round,
  style,
  active,
}: Omit<IconButtonChromeOptions, "state"> & { active?: boolean }) {
  const scope = useContext(IconButtonChromeContext);
  return useCallback(
    (state: IconButtonChromeState) =>
      iconButtonChromeStyle({
        size: scope === "header-island" ? "large" : size,
        compact,
        disabled,
        round: scope === "header-island" || round,
        style,
        state: { ...state, active: active || state.active },
      }),
    [scope, size, compact, disabled, round, style, active],
  );
}

/** Shared hitbox and interaction chrome for icon-only header and toolbar controls. */
export function iconButtonChromeStyle({
  size,
  state,
  compact = false,
  disabled = false,
  round = false,
  style,
}: IconButtonChromeOptions): StyleProp<ViewStyle> {
  const highlighted = state?.active || state?.hovered || state?.pressed || state?.open;
  return [
    resolveIconButtonFrame(size, compact),
    round ? styles.round : null,
    style,
    highlighted ? styles.highlighted : null,
    disabled ? styles.disabled : null,
  ];
}

/** Frame-only form for non-interactive placeholders that must preserve header alignment. */
export function iconButtonChromeFrameStyle(
  size: IconButtonChromeSize,
  compact = false,
): StyleProp<ViewStyle> {
  return resolveIconButtonFrame(size, compact);
}

export function iconButtonChromeGlyphSize(size: IconButtonChromeSize, compact = false): number {
  return GLYPH_SIZES[size][controlSizingForLayout(compact)];
}

export function smallIconButtonChromeFrameSize(compact = false): number {
  return ICON_BUTTON_SIZES.small[controlSizingForLayout(compact)];
}

const styles = StyleSheet.create((theme) => ({
  large: {
    width: bySizing(ICON_BUTTON_SIZES.large),
    height: bySizing(ICON_BUTTON_SIZES.large),
    padding: 0,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  small: {
    width: ICON_BUTTON_SIZES.small.pointer,
    height: ICON_BUTTON_SIZES.small.pointer,
    padding: 0,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  smallTouch: {
    width: ICON_BUTTON_SIZES.small.touch,
    height: ICON_BUTTON_SIZES.small.touch,
    padding: 0,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  round: {
    borderRadius: theme.borderRadius.full,
  },
  highlighted: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  disabled: {
    opacity: theme.opacity[50],
  },
}));
