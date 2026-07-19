import {
  forwardRef,
  useCallback,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Pressable,
  View,
  type NativeSyntheticEvent,
  type PressableProps,
  type PressableStateCallbackType,
  type TargetedEvent,
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
  focused: boolean;
}

type TriggerStyleProp = StyleProp<ViewStyle> | ((state: TriggerState) => StyleProp<ViewStyle>);

interface ComboboxTriggerProps extends Omit<PressableProps, "style" | "children"> {
  style?: TriggerStyleProp;
  children?: ReactNode;
  chevron?: ReactNode | null;
  // Fill the Pressable's width and use the standard sidebar-row gap, so the
  // trigger reads as a full-width row: the label expands and the chevron pins to
  // the trailing edge. Default (false) keeps the content-width pill used by the
  // composer triggers.
  block?: boolean;
}

export const ComboboxTrigger = forwardRef<View, ComboboxTriggerProps>(function ComboboxTrigger(
  { children, chevron, style, block = false, onFocus, onBlur, ...props },
  ref,
): ReactElement {
  const [focused, setFocused] = useState(false);
  const pressableStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => {
      if (typeof style === "function") {
        return style({ pressed, hovered, focused });
      }
      return style;
    },
    [focused, style],
  );
  const handleFocus = useCallback(
    (event: NativeSyntheticEvent<TargetedEvent>) => {
      setFocused(true);
      onFocus?.(event);
    },
    [onFocus],
  );
  const handleBlur = useCallback(
    (event: NativeSyntheticEvent<TargetedEvent>) => {
      setFocused(false);
      onBlur?.(event);
    },
    [onBlur],
  );

  const rowStyle = useMemo(() => [styles.row, block && styles.rowBlock], [block]);

  return (
    <Pressable
      ref={ref}
      collapsable={false}
      style={pressableStyle}
      onFocus={handleFocus}
      onBlur={handleBlur}
      {...props}
    >
      <View style={rowStyle}>
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
    minWidth: 0,
    maxWidth: "100%",
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  rowBlock: {
    flexGrow: 1,
    gap: theme.spacing[2],
  },
  chevronContainer: {
    flexShrink: 0,
    transform: [{ translateY: 1 }],
  },
}));
