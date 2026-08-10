import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";

interface RadioProps {
  selected: boolean;
  /**
   * Preview the choice the pointer would make: draws the dot faintly so the row
   * under the cursor shows what pressing it does, without claiming to be the
   * current value.
   */
  preview?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The indicator for one-of-N.
 *
 * Presentational only — whatever row or option owns it is the control, so this
 * never handles a press. A circle means exactly one of these is chosen; a square
 * would mean each is independently on or off. That distinction already lives in
 * `question-form-card.tsx`, which draws single-select round and multi-select
 * square; this is the same shape and the same tokens, extracted so a third copy
 * does not drift from the first two.
 *
 * The ring is always drawn, so selecting only swaps the border colour and the
 * dot. Nothing reflows under the cursor.
 */
export function Radio({ selected, preview = false, style, testID }: RadioProps) {
  return (
    <View style={[styles.ring, selected && styles.ringSelected, style]} testID={testID}>
      {selected || preview ? (
        <View
          style={[styles.dot, preview && styles.dotPreview]}
          testID={testID ? `${testID}-dot` : undefined}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  ring: {
    width: 18,
    height: 18,
    borderRadius: 999,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.foregroundMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  ringSelected: {
    borderColor: theme.colors.accent,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: theme.colors.accent,
  },
  dotPreview: {
    backgroundColor: theme.colors.foregroundMuted,
    opacity: theme.opacity[50],
  },
}));
