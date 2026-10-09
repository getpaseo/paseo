import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useHostReportsUsage } from "@/usage";
import type { Theme } from "@/styles/theme";
import { ContextWindowDetails } from "./context-window-details";
import { ContextWindowSheet } from "./context-window-sheet";
import { formatContextPercentage } from "./context-window-meter.utils";

interface ContextWindowMeterProps {
  serverId: string;
  agentId: string;
  maxTokens: number | null;
  usedTokens: number | null;
  totalCostUsd?: number | null;
  showPercentage?: boolean;
  /** Optional glyph envelope for icon-toolbar alignment. */
  glyphSize?: number;
}

const SVG_SIZE = 14;
const USAGE_POPOVER_WIDTH = 300;
const COMPACT_SVG_SIZE = 12;
const COMPACT_RADIUS = 5;
const STROKE_WIDTH = 2;
const COMPACT_STROKE_WIDTH = 1.75;

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

function formatSessionCost(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}

function getProgressColor(percentage: number, theme: Theme): string {
  if (percentage > 90) {
    return theme.colors.destructive;
  }
  if (percentage >= 70) {
    return theme.colors.palette.amber[500];
  }
  return theme.colors.foregroundMuted;
}

function getMeterGeometry(showPercentage: boolean, glyphSize?: number) {
  if (showPercentage) {
    return {
      svgSize: COMPACT_SVG_SIZE,
      radius: COMPACT_RADIUS,
      strokeWidth: COMPACT_STROKE_WIDTH,
      containerStyle: styles.containerWithLabel,
    };
  }
  const resolvedSize = glyphSize ?? SVG_SIZE;
  const resolvedStrokeWidth = glyphSize ? 2 : STROKE_WIDTH;
  return {
    svgSize: resolvedSize,
    radius: (resolvedSize - resolvedStrokeWidth) / 2,
    strokeWidth: resolvedStrokeWidth,
    containerStyle: styles.container,
  };
}

// Wrap the whole SVG: withUnistyles adds a div on web, which cannot sit inside an SVG.
const ContextWindowRing = withUnistyles(function ContextWindowRing({
  size,
  radius,
  strokeWidth,
  percentage,
  trackColor,
  progressColor,
}: {
  size: number;
  radius: number;
  strokeWidth: number;
  percentage: number | null;
  trackColor: string;
  progressColor: string;
}) {
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={trackColor}
        strokeWidth={strokeWidth}
      />
      {percentage !== null ? (
        <Circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={progressColor}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - (clampPercentage(percentage) / 100) * circumference}
          // SVG strokes start at three o'clock; the ring reads clockwise from twelve.
          transform={`rotate(-90 ${center} ${center})`}
        />
      ) : null}
    </Svg>
  );
});

export function ContextWindowMeter({
  serverId,
  agentId,
  maxTokens,
  usedTokens,
  totalCostUsd,
  showPercentage = false,
  glyphSize,
}: ContextWindowMeterProps) {
  const { t, i18n } = useTranslation();
  const { width } = useWindowDimensions();
  // Usage cards need a wider popover; without them it keeps the plain tooltip shape.
  const showsUsage = useHostReportsUsage(serverId);
  const popoverWidth = Math.min(USAGE_POPOVER_WIDTH, width - 24);
  // Compact screens open the details in a sheet, which can hold a pressable Refresh.
  const isCompact = useIsCompactFormFactor();
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const openSheet = useCallback(() => setIsSheetOpen(true), []);
  const closeSheet = useCallback(() => setIsSheetOpen(false), []);
  const percentage =
    maxTokens !== null && usedTokens !== null ? getUsagePercentage(maxTokens, usedTokens) : null;
  const geometry = getMeterGeometry(showPercentage, glyphSize);

  const context = useMemo(
    () =>
      percentage !== null && maxTokens !== null && usedTokens !== null
        ? { percentage: Math.round(percentage), maxTokens, usedTokens }
        : null,
    [percentage, maxTokens, usedTokens],
  );
  const meterColors = useCallback(
    (theme: Theme) => ({
      progressColor: getProgressColor(percentage ?? 0, theme),
      trackColor: theme.colors.surface3,
    }),
    [percentage],
  );
  const formattedSessionCost =
    typeof totalCostUsd === "number" ? formatSessionCost(totalCostUsd) : null;
  const containerStyle = geometry.containerStyle;
  const ring = (
    <ContextWindowRing
      size={geometry.svgSize}
      radius={geometry.radius}
      strokeWidth={geometry.strokeWidth}
      percentage={percentage}
      uniProps={meterColors}
    />
  );
  const percentageLabel =
    showPercentage && context ? (
      <Text style={styles.percentageLabel}>
        {formatContextPercentage(context.percentage, i18n.resolvedLanguage)}
      </Text>
    ) : null;
  const accessibilityLabel = context
    ? t("contextWindow.accessibility", { percentage: context.percentage })
    : t("contextWindow.accessibilityNoData");

  if (isCompact) {
    return (
      <>
        <Pressable
          style={containerStyle}
          testID="context-window-meter"
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          onPress={openSheet}
        >
          {ring}
          {percentageLabel}
        </Pressable>
        <ContextWindowSheet open={isSheetOpen} onClose={closeSheet}>
          <ContextWindowDetails
            serverId={serverId}
            agentId={agentId}
            context={context}
            sessionCost={formattedSessionCost}
            showTitle={false}
            refreshable
          />
        </ContextWindowSheet>
      </>
    );
  }

  const popoverStyle = showsUsage
    ? [styles.usagePopover, { width: popoverWidth }]
    : styles.plainPopover;

  // Native wide screens have no hover, so the details open in a tooltip on press. The tooltip
  // takes no presses, so its usage cards have no Refresh.
  if (isNative) {
    return (
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
        <TooltipTrigger asChild triggerRefProp="ref">
          <Pressable
            style={containerStyle}
            testID="context-window-meter"
            accessibilityRole="image"
            accessibilityLabel={accessibilityLabel}
          >
            {ring}
            {percentageLabel}
          </Pressable>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="center"
          offset={8}
          maxWidth={showsUsage ? popoverWidth : undefined}
          style={popoverStyle}
          testID="context-window-meter-tooltip"
        >
          <ContextWindowDetails
            serverId={serverId}
            agentId={agentId}
            context={context}
            sessionCost={formattedSessionCost}
            showTitle
            refreshable={false}
          />
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <HoverCard>
      <HoverCardTrigger focusable accessibilityLabel={accessibilityLabel}>
        <View
          style={containerStyle}
          testID="context-window-meter"
          accessibilityRole="image"
          accessibilityLabel={accessibilityLabel}
        >
          {ring}
          {percentageLabel}
        </View>
      </HoverCardTrigger>
      <HoverCardContent
        placement="top"
        offset={8}
        role="dialog"
        accessibilityLabel={t("contextWindow.title")}
        testID="context-window-details"
        style={popoverStyle}
      >
        <ContextWindowDetails
          serverId={serverId}
          agentId={agentId}
          context={context}
          sessionCost={formattedSessionCost}
          showTitle
          refreshable
          scrollable
        />
      </HoverCardContent>
    </HoverCard>
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
  percentageLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  // Plain details use a small inset; account usage cards have their own content density.
  plainPopover: { paddingVertical: theme.spacing[1], paddingHorizontal: theme.spacing[2] },
  usagePopover: { padding: theme.spacing[3], gap: theme.spacing[3] },
}));
