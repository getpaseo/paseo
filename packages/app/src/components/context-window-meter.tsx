import { Pressable, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface ContextWindowMeterProps {
  maxTokens: number;
  usedTokens: number;
}

const SVG_SIZE = 16;
const CENTER = SVG_SIZE / 2;
const RADIUS = 7;
const STROKE_WIDTH = 2.25;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function isValidMaxTokens(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isValidUsedTokens(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function getUsagePercentage(maxTokens: number, usedTokens: number): number | null {
  if (!isValidMaxTokens(maxTokens) || !isValidUsedTokens(usedTokens)) {
    return null;
  }
  return (usedTokens / maxTokens) * 100;
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 1_000_000)}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return Math.round(value).toString();
}

function getMeterColors(
  percentage: number,
  theme: ReturnType<typeof useUnistyles>["theme"],
): { progress: string; track: string } {
  const track = theme.colors.surface3;
  if (percentage > 90) {
    return { progress: theme.colors.destructive, track };
  }
  if (percentage >= 70) {
    return { progress: theme.colors.palette.amber[500], track };
  }
  return { progress: theme.colors.foregroundMuted, track };
}

export function ContextWindowMeter({ maxTokens, usedTokens }: ContextWindowMeterProps) {
  const { theme } = useUnistyles();
  const percentage = getUsagePercentage(maxTokens, usedTokens);

  if (percentage === null) {
    return null;
  }

  const clampedPercentage = clampPercentage(percentage);
  const roundedPercentage = Math.round(percentage);
  const dashOffset = CIRCUMFERENCE - (clampedPercentage / 100) * CIRCUMFERENCE;
  const colors = getMeterColors(clampedPercentage, theme);

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild triggerRefProp="ref">
        <Pressable
          style={styles.container}
          accessibilityRole="image"
          accessibilityLabel={`Context window ${roundedPercentage}% used`}
        >
          <Svg
            width={SVG_SIZE}
            height={SVG_SIZE}
            viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
            style={styles.svg}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Circle
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              stroke={colors.track}
              strokeWidth={STROKE_WIDTH}
            />
            <Circle
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              stroke={colors.progress}
              strokeWidth={STROKE_WIDTH}
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
            />
          </Svg>
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <View style={styles.tooltipContent}>
          <Text style={styles.tooltipTitle}>Context window</Text>
          <Text style={styles.tooltipText}>{`${roundedPercentage}% used`}</Text>
          <Text
            style={styles.tooltipDetail}
          >{`${formatTokenCount(usedTokens)} / ${formatTokenCount(maxTokens)} tokens`}</Text>
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  svg: {
    transform: [{ rotate: "-90deg" }],
  },
  tooltipContent: {
    gap: theme.spacing[1],
  },
  tooltipTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  tooltipDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.4,
  },
}));
