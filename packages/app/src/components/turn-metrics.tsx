import { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { ChartNoAxesColumn } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentMetric } from "@getpaseo/protocol/agent-types";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  useHoverCardOpen,
} from "@/components/ui/hover-card";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { DetailsSheet } from "./details-sheet";
import { MetricsList } from "./metrics-list";

const ThemedChart = withUnistyles(ChartNoAxesColumn);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * The turn footer's stats button: what the provider reported about this turn, in a hover card on
 * web, a tooltip opened by press on native wide screens, and a sheet on compact screens.
 */
export const TurnMetricsButton = memo(function TurnMetricsButton({
  metrics,
}: {
  metrics: AgentMetric[];
}) {
  const isCompact = useIsCompactFormFactor();
  if (isCompact) return <TurnMetricsSheetButton metrics={metrics} />;
  if (isNative) return <TurnMetricsTooltipButton metrics={metrics} />;
  return <TurnMetricsHoverCardButton metrics={metrics} />;
});

function TurnMetricsSheetButton({ metrics }: { metrics: AgentMetric[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const openSheet = useCallback(() => setOpen(true), []);
  const closeSheet = useCallback(() => setOpen(false), []);
  return (
    <>
      <PressHighlight
        style={styles.trigger}
        accessibilityRole="button"
        accessibilityLabel={t("message.actions.turnStats")}
        onPress={openSheet}
        testID="turn-metrics-trigger"
      >
        {({ hovered }) => <TurnMetricsIcon active={open || Boolean(hovered)} />}
      </PressHighlight>
      <DetailsSheet open={open} onClose={closeSheet} title={t("message.actions.turnStats")}>
        <MetricsList metrics={metrics} />
      </DetailsSheet>
    </>
  );
}

function TurnMetricsTooltipButton({ metrics }: { metrics: AgentMetric[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen} delayDuration={0} enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild triggerRefProp="ref">
        <PressHighlight
          style={styles.trigger}
          accessibilityRole="button"
          accessibilityLabel={t("message.actions.turnStats")}
          testID="turn-metrics-trigger"
        >
          {({ hovered }) => <TurnMetricsIcon active={open || Boolean(hovered)} />}
        </PressHighlight>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" offset={8} style={styles.popover}>
        <TurnMetricsDetails metrics={metrics} />
      </TooltipContent>
    </Tooltip>
  );
}

function TurnMetricsHoverCardButton({ metrics }: { metrics: AgentMetric[] }) {
  const { t } = useTranslation();
  return (
    <HoverCard>
      <HoverCardTrigger focusable accessibilityLabel={t("message.actions.turnStats")}>
        <View style={styles.trigger} testID="turn-metrics-trigger">
          <HoverCardTurnMetricsIcon />
        </View>
      </HoverCardTrigger>
      <HoverCardContent
        placement="top"
        alignment="start"
        offset={8}
        role="dialog"
        accessibilityLabel={t("message.actions.turnStats")}
        testID="turn-metrics-details"
        style={styles.popover}
      >
        <TurnMetricsDetails metrics={metrics} />
      </HoverCardContent>
    </HoverCard>
  );
}

function HoverCardTurnMetricsIcon() {
  return <TurnMetricsIcon active={useHoverCardOpen()} />;
}

function TurnMetricsIcon({ active }: { active: boolean }) {
  return (
    <ThemedChart
      size={ICON_SIZE.sm}
      uniProps={active ? foregroundColorMapping : foregroundMutedColorMapping}
    />
  );
}

function TurnMetricsDetails({ metrics }: { metrics: AgentMetric[] }) {
  const { t } = useTranslation();
  return (
    <>
      <Text style={styles.title}>{t("message.actions.turnStats")}</Text>
      <MetricsList metrics={metrics} />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Matches the Copy and Fork buttons beside it, so the glyphs share one row and one spacing.
  trigger: {
    alignSelf: "center",
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  popover: {
    minWidth: 220,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
