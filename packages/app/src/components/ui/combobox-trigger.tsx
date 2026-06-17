import { forwardRef, useCallback, type ReactElement, type ReactNode } from "react";
import {
  Pressable,
  View,
  type PressableProps,
  type PressableStateCallbackType,
  type ViewStyle,
  type StyleProp,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);

const chevronColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

interface TriggerState {
  pressed: boolean;
  hovered: boolean;
}

type TriggerStyleProp = StyleProp<ViewStyle> | ((state: TriggerState) => StyleProp<ViewStyle>);

interface ComboboxTriggerProps extends Omit<PressableProps, "style" | "children"> {
  style?: TriggerStyleProp;
  children?: ReactNode;
  chevron?: ReactNode | null;
}

export const ComboboxTrigger = forwardRef<View, ComboboxTriggerProps>(function ComboboxTrigger(
  { children, chevron, style, ...props },
  ref,
): ReactElement {
  const pressableStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => {
      if (typeof style === "function") {
        return style({ pressed, hovered });
      }
      return style;
    },
    [style],
  );

  return (
    <Pressable ref={ref} collapsable={false} style={pressableStyle} {...props}>
      <View style={styles.row}>
        {children}
        {chevron !== null &&
          (chevron ?? (
            <View style={styles.chevronContainer}>
              <ThemedChevronDown size={ICON_SIZE.sm} uniProps={chevronColorMapping} />
            </View>
          ))}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  chevronContainer: {
    transform: [{ translateY: 1 }],
  },
}));
