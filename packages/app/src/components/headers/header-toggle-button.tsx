import { useMemo, type ReactElement, type ReactNode } from "react";
import { Text, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Shortcut } from "@/components/ui/shortcut";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { isWeb } from "@/constants/platform";
import {
  iconButtonChromeFrameStyle,
  iconButtonChromeStyle,
} from "@/components/ui/icon-button-chrome";

interface HeaderToggleButtonState {
  hovered: boolean;
  pressed: boolean;
}

interface HeaderToggleButtonProps extends Omit<PressableProps, "style" | "onPress" | "children"> {
  onPress: NonNullable<PressableProps["onPress"]>;
  tooltipLabel: string;
  tooltipKeys: ShortcutKey[];
  tooltipSide: "left" | "right" | "top" | "bottom";
  tooltipDelayDuration?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode | ((state: HeaderToggleButtonState) => ReactNode);
}

export function HeaderToggleButton({
  onPress,
  tooltipLabel,
  tooltipKeys,
  tooltipSide,
  tooltipDelayDuration = 0,
  style,
  disabled,
  children,
  ...props
}: HeaderToggleButtonProps): ReactElement {
  const tooltipTestID =
    typeof props.testID === "string" && props.testID.length > 0
      ? `${props.testID}-tooltip`
      : undefined;
  const expandedState = (props.accessibilityState as { expanded?: boolean } | undefined)?.expanded;
  const ariaExpandedProps =
    isWeb && typeof expandedState === "boolean"
      ? ({ "aria-expanded": expandedState } as Record<string, boolean>)
      : null;

  const combinedStyle = useMemo(
    () =>
      ({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) =>
        iconButtonChromeStyle({
          size: "large",
          state: { hovered: Boolean(hovered), pressed },
          disabled: Boolean(disabled),
          style,
        }),
    [disabled, style],
  );

  return (
    <Tooltip delayDuration={tooltipDelayDuration} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        {...props}
        {...ariaExpandedProps}
        disabled={disabled}
        onPress={onPress}
        style={combinedStyle}
      >
        {typeof children === "function"
          ? (state: { pressed: boolean; hovered?: boolean }) =>
              children({ hovered: Boolean(state.hovered), pressed: state.pressed })
          : children}
      </TooltipTrigger>
      <TooltipContent testID={tooltipTestID} side={tooltipSide} align="center" offset={8}>
        <View style={styles.tooltipRow}>
          <Text style={styles.tooltipText}>{tooltipLabel}</Text>
          <Shortcut keys={tooltipKeys} style={styles.shortcut} />
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
  shortcut: {},
}));

export const headerIconSlotStyle = {
  slot: iconButtonChromeFrameStyle("large"),
};
