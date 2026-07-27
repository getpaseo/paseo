import { useCallback, useState } from "react";
import type { TFunction } from "i18next";
import { Pressable, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ProviderUsageTooltipSection } from "@/provider-usage/tooltip-section";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { isWeb } from "@/constants/platform";
import { formatTokenCount } from "./context-window-meter.utils";

/** Hide decorative meter rings from AT without leaking RN-only props to web SVG DOM. */
const decorativeSvgAccessibilityProps = isWeb
  ? ({ "aria-hidden": true } as const)
  : {
      accessibilityElementsHidden: true,
      importantForAccessibility: "no-hide-descendants" as const,
    };

interface ContextWindowMeterProps {
  maxTokens: number | null;
  usedTokens: number | null;
  /** Indicates that usage was inferred locally rather than reported by the provider. */
  estimated?: boolean;
  totalCostUsd?: number | null;
  showPercentage?: boolean;
  serverId?: string;
  /** The Paseo provider key, e.g. "claude", "gemini", "codex" */
  provider?: string | null;
  /** Reserve the meter footprint and show a loading ring while usage is pending. */
  pending?: boolean;
  /** Keep an empty, inspectable meter visible when the provider has no context limit. */
  showUnavailable?: boolean;
  /** Optional glyph envelope for icon-toolbar alignment. */
  glyphSize?: number;
}

const SVG_SIZE = 14;
const COMPACT_SVG_SIZE = 12;
const COMPACT_CENTER = COMPACT_SVG_SIZE / 2;
const COMPACT_RADIUS = 5;
const STROKE_WIDTH = 2;
const COMPACT_STROKE_WIDTH = 1.75;
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

function getMeterGeometry(showPercentage: boolean, glyphSize?: number) {
  if (showPercentage) {
    return {
      svgSize: COMPACT_SVG_SIZE,
      center: COMPACT_CENTER,
      radius: COMPACT_RADIUS,
      strokeWidth: COMPACT_STROKE_WIDTH,
      circumference: COMPACT_CIRCUMFERENCE,
      containerStyle: styles.containerWithLabel,
    };
  }
  const resolvedSize = glyphSize ?? SVG_SIZE;
  const resolvedStrokeWidth = glyphSize ? 2 : STROKE_WIDTH;
  return {
    svgSize: resolvedSize,
    center: resolvedSize / 2,
    radius: (resolvedSize - resolvedStrokeWidth) / 2,
    strokeWidth: resolvedStrokeWidth,
    circumference: Math.PI * (resolvedSize - resolvedStrokeWidth),
    containerStyle: styles.container,
  };
}

interface UnavailableContextWindowMeterProps {
  geometry: ReturnType<typeof getMeterGeometry>;
  showPercentage: boolean;
  theme: ReturnType<typeof useUnistyles>["theme"];
  t: TFunction;
  isTooltipOpen: boolean;
  onTooltipOpenChange: (open: boolean) => void;
  serverId?: string;
  provider?: string | null;
}

function UnavailableContextWindowMeter({
  geometry,
  showPercentage,
  theme,
  t,
  isTooltipOpen,
  onTooltipOpenChange,
  serverId,
  provider,
}: UnavailableContextWindowMeterProps) {
  const { view: providerUsageView } = useProviderUsage(serverId ?? null, {
    enabled: isTooltipOpen,
  });
  return (
    <Tooltip
      open={isTooltipOpen}
      onOpenChange={onTooltipOpenChange}
      delayDuration={0}
      enabledOnDesktop
      enabledOnMobile
    >
      <TooltipTrigger asChild triggerRefProp="ref">
        <Pressable
          style={geometry.containerStyle}
          testID="context-window-meter"
          accessibilityRole="image"
          accessibilityLabel={t("contextWindow.accessibilityUnavailable")}
        >
          <Svg
            width={geometry.svgSize}
            height={geometry.svgSize}
            viewBox={`0 0 ${geometry.svgSize} ${geometry.svgSize}`}
            style={styles.svg}
            {...decorativeSvgAccessibilityProps}
          >
            <Circle
              cx={geometry.center}
              cy={geometry.center}
              r={geometry.radius}
              fill="none"
              stroke={theme.colors.surface3}
              strokeWidth={geometry.strokeWidth}
            />
          </Svg>
          {showPercentage ? <Text style={styles.percentageLabel}>--</Text> : null}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8} style={styles.tooltipShell}>
        <View style={styles.tooltipSection}>
          <Text style={styles.tooltipTitle}>{t("contextWindow.title")}</Text>
          <Text style={styles.tooltipText}>{t("contextWindow.usageUnavailable")}</Text>
        </View>
        <ProviderUsageTooltipSection view={providerUsageView} activeProviderId={provider} />
      </TooltipContent>
    </Tooltip>
  );
}

// oxlint-disable-next-line complexity -- The known, pending, and unavailable states share one tooltip lifecycle.
export function ContextWindowMeter({
  maxTokens,
  usedTokens,
  estimated = false,
  totalCostUsd,
  showPercentage = false,
  serverId,
  provider,
  pending = false,
  showUnavailable = false,
  glyphSize,
}: ContextWindowMeterProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const { view: providerUsageView, refresh: refreshProviderUsage } = useProviderUsage(
    serverId ?? null,
    { enabled: isTooltipOpen },
  );
  const percentage =
    maxTokens !== null && usedTokens !== null ? getUsagePercentage(maxTokens, usedTokens) : null;
  const hasKnownLimit = maxTokens !== null && isValidMaxTokens(maxTokens);
  const handleTooltipOpenChange = useCallback(
    (nextOpen: boolean) => {
      setIsTooltipOpen(nextOpen);
      if (nextOpen) {
        void refreshProviderUsage().catch(() => {});
      }
    },
    [refreshProviderUsage],
  );

  const geometry = getMeterGeometry(showPercentage, glyphSize);

  // Preserve a useful inspection target for providers that do not report their
  // context limit. The track still exposes provider usage cards.
  if (!hasKnownLimit) {
    if (!pending && !showUnavailable) {
      return null;
    }
    if (!showUnavailable) {
      return (
        <View style={geometry.containerStyle}>
          <LoadingSpinner size={geometry.svgSize} color={theme.colors.foregroundMuted} />
        </View>
      );
    }
    return (
      <UnavailableContextWindowMeter
        geometry={geometry}
        showPercentage={showPercentage}
        theme={theme}
        t={t}
        isTooltipOpen={isTooltipOpen}
        onTooltipOpenChange={handleTooltipOpenChange}
        serverId={serverId}
        provider={provider}
      />
    );
  }

  const hasUsage = percentage !== null && usedTokens !== null;
  const clampedPercentage = hasUsage ? clampPercentage(percentage) : 0;
  const roundedPercentage = hasUsage ? Math.round(percentage) : null;
  const { svgSize, center, radius, strokeWidth, circumference, containerStyle } = geometry;
  const dashOffset = circumference - (clampedPercentage / 100) * circumference;
  const colors = getMeterColors(clampedPercentage, theme);
  const formattedSessionCost =
    typeof totalCostUsd === "number" ? formatSessionCost(totalCostUsd) : null;

  return (
    <Tooltip
      open={isTooltipOpen}
      onOpenChange={handleTooltipOpenChange}
      delayDuration={0}
      enabledOnDesktop
      enabledOnMobile
    >
      <TooltipTrigger asChild triggerRefProp="ref">
        <Pressable
          style={containerStyle}
          testID="context-window-meter"
          accessibilityRole="image"
          accessibilityLabel={
            roundedPercentage === null
              ? t("contextWindow.accessibilityUnavailable")
              : t(
                  estimated
                    ? "contextWindow.accessibilityEstimated"
                    : "contextWindow.accessibility",
                  { percentage: roundedPercentage },
                )
          }
        >
          <Svg
            width={svgSize}
            height={svgSize}
            viewBox={`0 0 ${svgSize} ${svgSize}`}
            style={styles.svg}
            {...decorativeSvgAccessibilityProps}
          >
            <Circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={colors.track}
              strokeWidth={strokeWidth}
            />
            {hasUsage ? (
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
            ) : null}
          </Svg>
          {showPercentage ? (
            <Text style={styles.percentageLabel}>
              {roundedPercentage === null ? "--" : `${estimated ? "~" : ""}${roundedPercentage}%`}
            </Text>
          ) : null}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8} style={styles.tooltipShell}>
        <View style={styles.tooltipSection}>
          <Text style={styles.tooltipTitle}>{t("contextWindow.title")}</Text>
          {roundedPercentage === null || usedTokens === null ? (
            <>
              <Text style={styles.tooltipText}>{t("contextWindow.usageUnavailable")}</Text>
              <Text style={styles.tooltipDetail}>
                {t("contextWindow.limit", { max: formatTokenCount(maxTokens) })}
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.tooltipText}>
                {t(estimated ? "contextWindow.usedEstimated" : "contextWindow.used", {
                  percentage: roundedPercentage,
                })}
              </Text>
              <Text style={styles.tooltipDetail}>
                {t("contextWindow.tokens", {
                  used: formatTokenCount(usedTokens),
                  max: formatTokenCount(maxTokens),
                })}
              </Text>
            </>
          )}
          {estimated ? (
            <Text style={styles.tooltipDetail}>{t("contextWindow.estimateNotice")}</Text>
          ) : null}
          {formattedSessionCost ? (
            <Text style={styles.tooltipDetail}>
              {t("contextWindow.sessionCost", { cost: formattedSessionCost })}
            </Text>
          ) : null}
        </View>
        <ProviderUsageTooltipSection view={providerUsageView} activeProviderId={provider} />
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
  // Zero the shared TooltipContent padding so this popover owns a single
  // equal inset on every edge (see tooltipSection / provider usage section).
  tooltipShell: {
    paddingVertical: 0,
    paddingHorizontal: 0,
    minWidth: 220,
  },
  tooltipSection: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
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
