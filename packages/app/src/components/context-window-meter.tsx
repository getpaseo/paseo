import { Pressable, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface ContextWindowMeterProps {
  maxTokens: number;
  usedTokens: number;
  totalCostUsd?: number | null;
  showPercentage?: boolean;
}

const SVG_SIZE = 16;
const COMPACT_SVG_SIZE = 14;
const CENTER = SVG_SIZE / 2;
const COMPACT_CENTER = COMPACT_SVG_SIZE / 2;
const RADIUS = 7;
const COMPACT_RADIUS = 6;
const STROKE_WIDTH = 2.25;
const COMPACT_STROKE_WIDTH = 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const COMPACT_CIRCUMFERENCE = 2 * Math.PI * COMPACT_RADIUS;

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

function formatSessionCost(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
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

export function ContextWindowMeter({
  maxTokens,
  usedTokens,
  totalCostUsd,
  showPercentage = false,
}: ContextWindowMeterProps) {
  const { theme } = useUnistyles();
  const percentage = getUsagePercentage(maxTokens, usedTokens);

  if (percentage === null) {
    return null;
  }

  const clampedPercentage = clampPercentage(percentage);
  const roundedPercentage = Math.round(percentage);
  const svgSize = showPercentage ? COMPACT_SVG_SIZE : SVG_SIZE;
  const center = showPercentage ? COMPACT_CENTER : CENTER;
  const radius = showPercentage ? COMPACT_RADIUS : RADIUS;
  const strokeWidth = showPercentage ? COMPACT_STROKE_WIDTH : STROKE_WIDTH;
  const circumference = showPercentage ? COMPACT_CIRCUMFERENCE : CIRCUMFERENCE;
  const dashOffset = circumference - (clampedPercentage / 100) * circumference;
  const colors = getMeterColors(clampedPercentage, theme);
  const formattedSessionCost =
    typeof totalCostUsd === "number" ? formatSessionCost(totalCostUsd) : null;
  const containerStyle = showPercentage ? styles.containerWithLabel : styles.container;

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild triggerRefProp="ref">
        <Pressable
          style={containerStyle}
          accessibilityRole="image"
          accessibilityLabel={`Context window ${roundedPercentage}% used`}
        >
          <Svg
            width={svgSize}
            height={svgSize}
            viewBox={`0 0 ${svgSize} ${svgSize}`}
            style={styles.svg}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={colors.track}
              strokeWidth={strokeWidth}
            />
            <Circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={colors.progress}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
            />
          </Svg>
          {showPercentage ? (
            <Text style={styles.percentageLabel}>{`${roundedPercentage}%`}</Text>
          ) : null}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <View style={styles.tooltipContent}>
          <Text style={styles.tooltipTitle}>Context window</Text>
          <Text style={styles.tooltipText}>{`${roundedPercentage}% used`}</Text>
          <Text
            style={styles.tooltipDetail}
          >{`${formatTokenCount(usedTokens)} / ${formatTokenCount(maxTokens)} tokens`}</Text>
          {formattedSessionCost ? (
            <Text style={styles.tooltipDetail}>{`Session cost ${formattedSessionCost}`}</Text>
          ) : null}
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
  containerWithLabel: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
  },
  svg: {
    transform: [{ rotate: "-90deg" }],
  },
  percentageLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
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
