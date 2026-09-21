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
  /** Names the action; the button carries no label. */
  accessibilityLabel: string;
  onPress: () => void;
  testID?: string;
}

/**
 * The one floating action a scrolling surface can offer. It pins itself to the
 * bottom-right of its nearest positioned ancestor, so the ancestor decides what
 * the button may cover.
 */
export function FloatingActionButton({
  icon: Icon,
  accessibilityLabel,
  onPress,
  testID,
}: FloatingActionButtonProps) {
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={styles.button}
      highlightStyle={styles.pressed}
      testID={testID}
    >
      <Icon size={ICON_SIZE.lg} color={styles.glyph.color} />
    </PressHighlight>
  );
}

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
  pressed: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  glyph: {
    color: theme.colors.foreground,
  },
}));
