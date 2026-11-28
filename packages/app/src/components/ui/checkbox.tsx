import { Check } from "lucide-react-native";
import { useCallback, useMemo, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { PressHighlight } from "./press-highlight";

const ThemedCheck = withUnistyles(Check);
const checkedIconMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });

/** The checkbox glyph. A row that toggles it is a `CheckboxRow`. */
export function Checkbox({ checked }: { checked: boolean }) {
  return (
    <View style={checked ? styles.boxChecked : styles.box}>
      {checked ? <ThemedCheck size={14} uniProps={checkedIconMapping} /> : null}
    </View>
  );
}

interface HoverState {
  hovered?: boolean;
}

/**
 * A row that toggles a checkbox: the whole row is the hit area, it announces its checked state,
 * and Space toggles it on web. The caller lays out the row and passes what follows the box.
 */
export function CheckboxRow({
  checked,
  onToggle,
  accessibilityLabel,
  disabled = false,
  style,
  testID,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  accessibilityLabel: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children: ReactNode;
}) {
  const accessibilityState = useMemo(() => ({ checked, disabled }), [checked, disabled]);
  const rowStyle = useCallback(
    ({ hovered }: HoverState) => [style, hovered && !disabled ? styles.hovered : null],
    [disabled, style],
  );
  const keyProps = useMemo(() => {
    if (!isWeb || disabled) return {};
    return {
      // React Native Web's Pressable activates Space only for role="button", not checkbox.
      onKeyDown: (event: { key?: string; preventDefault?: () => void }) => {
        if (event.key === " " || event.key === "Spacebar") {
          event.preventDefault?.();
          onToggle();
        }
      },
    };
  }, [disabled, onToggle]);

  return (
    <PressHighlight
      style={rowStyle}
      highlightStyle={styles.pressed}
      onPress={onToggle}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      aria-checked={checked}
      testID={testID}
      {...keyProps}
    >
      <Checkbox checked={checked} />
      {children}
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  box: {
    width: 18,
    height: 18,
    flexShrink: 0,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  boxChecked: {
    width: 18,
    height: 18,
    flexShrink: 0,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  hovered: {
    backgroundColor: theme.colors.surface2,
  },
  pressed: {
    backgroundColor: theme.colors.surface3,
  },
}));
