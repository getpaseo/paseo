import { forwardRef, useMemo } from "react";
import { Text, type View } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ICON_SIZE, SPACING } from "@/styles/theme";

const FLOATING_ACTION_BUTTON_SIZE = 56;
const FLOATING_ACTION_BUTTON_INSET = SPACING[4];

/** Space a scrolling surface keeps below its content so the button traps nothing. */
export const FLOATING_ACTION_BUTTON_CLEARANCE =
  FLOATING_ACTION_BUTTON_SIZE + FLOATING_ACTION_BUTTON_INSET;

export interface FloatingActionButtonProps {
  icon: LucideIcon;
  /** Names the action for assistive technology. */
  accessibilityLabel: string;
  onPress: () => void;
  label?: string;
  disabled?: boolean;
  bottomInset?: number;
  testID?: string;
}

/**
 * Pins an action to the bottom-right of its nearest positioned ancestor.
 * The surface reserves scroll clearance and uses bottomInset to separate stacked actions.
 */
export const FloatingActionButton = forwardRef<View, FloatingActionButtonProps>(
  function FloatingActionButton(
    { icon: Icon, accessibilityLabel, onPress, label, disabled = false, bottomInset = 0, testID },
    ref,
  ) {
    const accessibilityState = useMemo(() => ({ disabled }), [disabled]);
    const buttonStyle = useMemo(
      () => [
        styles.button,
        label && styles.labeled,
        disabled && styles.disabled,
        { bottom: FLOATING_ACTION_BUTTON_INSET + bottomInset },
      ],
      [bottomInset, disabled, label],
    );
    return (
      <PressHighlight
        ref={ref}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
        disabled={disabled}
        onPress={onPress}
        style={buttonStyle}
        highlightStyle={styles.pressed}
        testID={testID}
      >
        <Icon size={ICON_SIZE.lg} color={styles.glyph.color} />
        {label ? <Text style={styles.label}>{label}</Text> : null}
      </PressHighlight>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  button: {
    position: "absolute",
    right: FLOATING_ACTION_BUTTON_INSET,
    bottom: FLOATING_ACTION_BUTTON_INSET,
    width: FLOATING_ACTION_BUTTON_SIZE,
    height: FLOATING_ACTION_BUTTON_SIZE,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    ...theme.shadow.md,
  },
  labeled: {
    width: "auto",
    minWidth: FLOATING_ACTION_BUTTON_SIZE,
    paddingHorizontal: theme.spacing[4],
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  disabled: { opacity: theme.opacity[50] },
  pressed: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  glyph: {
    color: theme.colors.foreground,
  },
}));
