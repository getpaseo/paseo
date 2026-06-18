import type { ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ResolvedPin } from "@/workspace-pins/launch";

function pinButtonStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.pinButton, (Boolean(hovered) || pressed) && styles.pinButtonHovered];
}

interface PinnedTargetsRowProps {
  launchers: ResolvedPin[];
  testIdPrefix: string;
}

export function PinnedTargetsRow({ launchers, testIdPrefix }: PinnedTargetsRowProps): ReactElement {
  return (
    <View style={styles.row}>
      {launchers.map((launcher) => (
        <Tooltip key={launcher.key} delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger
            testID={`${testIdPrefix}-${launcher.key}`}
            onPress={launcher.onPress}
            accessibilityRole="button"
            accessibilityLabel={launcher.label}
            style={pinButtonStyle}
          >
            {launcher.icon}
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" offset={8}>
            <Text style={styles.tooltipText}>{launcher.label}</Text>
          </TooltipContent>
        </Tooltip>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  pinButton: {
    width: 22,
    height: 22,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  pinButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
