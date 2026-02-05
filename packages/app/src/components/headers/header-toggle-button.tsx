import type { PropsWithChildren, ReactElement } from "react";
import { Text, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Shortcut } from "@/components/ui/shortcut";
import type { ShortcutKey } from "@/utils/format-shortcut";

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
}: PropsWithChildren<
  Omit<PressableProps, "style" | "onPress"> & {
    onPress: NonNullable<PressableProps["onPress"]>;
    tooltipLabel: string;
    tooltipKeys: ShortcutKey[];
    tooltipSide: "left" | "right" | "top" | "bottom";
    tooltipDelayDuration?: number;
    style?: StyleProp<ViewStyle>;
  }
>): ReactElement {
  const tooltipTestID =
    typeof props.testID === "string" && props.testID.length > 0
      ? `${props.testID}-tooltip`
      : undefined;

  return (
    <Tooltip delayDuration={tooltipDelayDuration} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        {...props}
        disabled={disabled}
        onPress={(e) => {
          onPress(e);
        }}
        style={[styles.button, style]}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent testID={tooltipTestID} side={tooltipSide} align="center" offset={8}>
        <View style={styles.tooltipRow}>
          <Text style={styles.tooltipText}>{tooltipLabel}</Text>
          <Shortcut keys={tooltipKeys} style={styles.shortcut} textStyle={styles.shortcutText} />
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    padding: {
      xs: theme.spacing[3],
      md: theme.spacing[2],
    },
    borderRadius: theme.borderRadius.lg,
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  shortcut: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.borderAccent,
  },
  shortcutText: {
    color: theme.colors.popoverForeground,
  },
}));
