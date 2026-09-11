import { Coffee } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsPreventingSleep, useSleepPreventionAgentCount } from "@/hooks/use-sleep-prevention";

const ThemedCoffee = withUnistyles(Coffee, (theme) => ({
  size: theme.iconSize.xs,
  color: theme.colors.foregroundMuted,
}));

/**
 * Shows that a daemon is holding its machine awake for a running agent.
 * Indicator only — the switch lives in host settings. Renders nothing when
 * nothing is being held, which is the common case.
 */
export function KeepAwakeIndicator() {
  const { t } = useTranslation();
  const isPreventingSleep = useIsPreventingSleep();
  const agentCount = useSleepPreventionAgentCount();

  if (!isPreventingSleep) return null;

  const label = t("desktop.keepAwake.tooltip", { count: agentCount });

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <View
          style={styles.badge}
          testID="keep-awake-indicator"
          accessible
          accessibilityLabel={label}
        >
          <ThemedCoffee />
        </View>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="center" offset={8}>
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  badge: {
    // The titlebar drag region is an absolutely positioned sibling, so it
    // paints above in-flow content and would swallow the tooltip's hover.
    position: "relative",
    zIndex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 22,
    width: 22,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));
