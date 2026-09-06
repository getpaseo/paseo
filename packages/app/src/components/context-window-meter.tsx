import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { AgentPromptCacheStatus } from "@getpaseo/protocol/agent-types";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ProviderUsageTooltipSection } from "@/provider-usage/tooltip-section";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { formatTokenCount } from "./context-window-meter.utils";
import { derivePromptCacheView, type PromptCacheLifetime } from "./prompt-cache-view";

interface ContextWindowMeterProps {
  maxTokens: number | null;
  usedTokens: number | null;
  totalCostUsd?: number | null;
  showPercentage?: boolean;
  serverId?: string;
  /** The Paseo provider key, e.g. "claude", "gemini", "codex" */
  provider?: string | null;
  /** Reserve the meter footprint and show a loading ring while usage is pending. */
  pending?: boolean;
  /** Optional glyph envelope for icon-toolbar alignment. */
  glyphSize?: number;
  /** Absent on daemons that do not report prompt cache figures. */
  promptCache?: AgentPromptCacheStatus | null;
  /** Sends a short message to the agent to re-warm its prompt cache. */
  onPingPromptCache?: () => Promise<void>;
  /** The agent is busy, so a ping would only queue behind its turn. */
  pingDisabled?: boolean;
}

type PingState = "idle" | "pending" | "failed";

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

function promptCacheDotStyle(lifetime: PromptCacheLifetime) {
  if (lifetime === "warm") return styles.promptCacheDotWarm;
  if (lifetime === "expiring") return styles.promptCacheDotExpiring;
  if (lifetime === "expired") return styles.promptCacheDotExpired;
  return styles.promptCacheDotUnknown;
}

function promptCacheStatusLabel(t: TFunction, lifetime: PromptCacheLifetime): string {
  if (lifetime === "warm") return t("contextWindow.promptCache.statusWarm");
  if (lifetime === "expiring") return t("contextWindow.promptCache.statusExpiring");
  if (lifetime === "expired") return t("contextWindow.promptCache.statusExpired");
  return t("contextWindow.promptCache.statusUnknown");
}

function formatCacheDuration(t: TFunction, seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds));
  if (safeSeconds < 60) {
    return t("contextWindow.promptCache.durationSeconds", { value: safeSeconds });
  }
  return t("contextWindow.promptCache.durationMinutes", { value: Math.round(safeSeconds / 60) });
}

function promptCacheTiming(t: TFunction, view: ReturnType<typeof derivePromptCacheView>): string {
  if (view.lifetime === "expired") {
    return t("contextWindow.promptCache.expiredAgo", {
      duration: formatCacheDuration(t, view.expiredForSeconds ?? 0),
    });
  }
  if (view.remainingSeconds === null) {
    return t("contextWindow.promptCache.lastRequestAgo", {
      duration: formatCacheDuration(t, view.elapsedSeconds),
    });
  }
  return t("contextWindow.promptCache.warmFor", {
    duration: formatCacheDuration(t, view.remainingSeconds),
  });
}

function promptCacheSplit(
  t: TFunction,
  split: ReturnType<typeof derivePromptCacheView>["lastRequest"],
): string {
  const cached = formatTokenCount(split.cachedTokens);
  const fresh = formatTokenCount(split.freshTokens);
  if (split.writtenTokens === null) {
    return t("contextWindow.promptCache.split", { cached, fresh });
  }
  return t("contextWindow.promptCache.splitWithWrite", {
    cached,
    fresh,
    written: formatTokenCount(split.writtenTokens),
  });
}

interface PromptCacheTooltipSectionProps {
  status: AgentPromptCacheStatus;
  pingState: PingState;
  onPing: (() => void) | null;
  pingDisabled: boolean;
}

// Rendered only while the tooltip is open, so the once-a-second countdown starts and
// stops with the surface the user is reading.
function PromptCacheTooltipSection({
  status,
  pingState,
  onPing,
  pingDisabled,
}: PromptCacheTooltipSectionProps) {
  const { t } = useTranslation();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const view = useMemo(() => derivePromptCacheView(status, nowMs), [status, nowMs]);

  return (
    <>
      <View style={styles.tooltipDivider} />
      <Text style={styles.tooltipTitle}>{t("contextWindow.promptCache.title")}</Text>
      <View style={styles.promptCacheStatusRow}>
        <View style={[styles.promptCacheDot, promptCacheDotStyle(view.lifetime)]} />
        <Text style={styles.tooltipText}>{promptCacheStatusLabel(t, view.lifetime)}</Text>
        <Text style={styles.tooltipDetail} numberOfLines={1}>
          {promptCacheTiming(t, view)}
        </Text>
      </View>
      <Text style={styles.tooltipDetail}>
        {t("contextWindow.promptCache.lastRequest", {
          percent: view.lastRequest.hitPercent,
          split: promptCacheSplit(t, view.lastRequest),
        })}
      </Text>
      <Text style={styles.tooltipDetail}>
        {t(
          view.session.requestCount === 1
            ? "contextWindow.promptCache.sessionSingular"
            : "contextWindow.promptCache.sessionPlural",
          { percent: view.session.hitPercent, count: view.session.requestCount },
        )}
      </Text>
      {onPing ? (
        <>
          <View style={styles.promptCachePingRow}>
            <Button
              variant="outline"
              size="sm"
              onPress={onPing}
              disabled={pingDisabled || pingState === "pending"}
            >
              {pingState === "pending"
                ? t("contextWindow.promptCache.pinging")
                : t("contextWindow.promptCache.ping")}
            </Button>
          </View>
          {/* The hint slot doubles as the failure slot so the section keeps its height. */}
          <Text
            style={
              pingState === "failed" ? styles.promptCachePingError : styles.promptCachePingHint
            }
            numberOfLines={2}
          >
            {pingState === "failed"
              ? t("contextWindow.promptCache.pingError")
              : t("contextWindow.promptCache.pingHint")}
          </Text>
        </>
      ) : null}
    </>
  );
}

export function ContextWindowMeter({
  maxTokens,
  usedTokens,
  totalCostUsd,
  showPercentage = false,
  serverId,
  provider,
  pending = false,
  glyphSize,
  promptCache,
  onPingPromptCache,
  pingDisabled = false,
}: ContextWindowMeterProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  // Ping state lives here, not in the section: the section unmounts every time the
  // tooltip closes, and a failure has to survive until the user tries again.
  const [pingState, setPingState] = useState<PingState>("idle");
  const { view: providerUsageView, refresh: refreshProviderUsage } = useProviderUsage(
    serverId ?? null,
    { enabled: isTooltipOpen },
  );
  const percentage =
    maxTokens !== null && usedTokens !== null ? getUsagePercentage(maxTokens, usedTokens) : null;
  const handleTooltipOpenChange = useCallback(
    (nextOpen: boolean) => {
      setIsTooltipOpen(nextOpen);
      if (nextOpen) {
        void refreshProviderUsage().catch(() => {});
      }
    },
    [refreshProviderUsage],
  );

  const handlePing = useCallback(() => {
    if (!onPingPromptCache) return;
    setPingState("pending");
    void onPingPromptCache().then(
      () => setPingState("idle"),
      () => setPingState("failed"),
    );
  }, [onPingPromptCache]);

  const geometry = getMeterGeometry(showPercentage, glyphSize);

  // No usage yet: reserve the footprint with a track-only ring while a session is
  // active so the real ring fades in without shifting siblings. Render nothing when
  // no usage is expected.
  if (percentage === null || maxTokens === null || usedTokens === null) {
    if (!pending) {
      return null;
    }
    return (
      <View style={geometry.containerStyle}>
        <Svg
          width={geometry.svgSize}
          height={geometry.svgSize}
          viewBox={`0 0 ${geometry.svgSize} ${geometry.svgSize}`}
          style={styles.svg}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
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
        {showPercentage ? <View style={styles.skeletonLabel} /> : null}
      </View>
    );
  }

  const clampedPercentage = clampPercentage(percentage);
  const roundedPercentage = Math.round(percentage);
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
      interactive={Boolean(promptCache && onPingPromptCache)}
    >
      <TooltipTrigger asChild triggerRefProp="ref">
        <Pressable
          style={containerStyle}
          testID="context-window-meter"
          accessibilityRole="image"
          accessibilityLabel={t("contextWindow.accessibility", {
            percentage: roundedPercentage,
          })}
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
          <Text style={styles.tooltipTitle}>{t("contextWindow.title")}</Text>
          <Text style={styles.tooltipText}>
            {t("contextWindow.used", { percentage: roundedPercentage })}
          </Text>
          <Text style={styles.tooltipDetail}>
            {t("contextWindow.tokens", {
              used: formatTokenCount(usedTokens),
              max: formatTokenCount(maxTokens),
            })}
          </Text>
          {formattedSessionCost ? (
            <Text style={styles.tooltipDetail}>
              {t("contextWindow.sessionCost", { cost: formattedSessionCost })}
            </Text>
          ) : null}
          {promptCache ? (
            <PromptCacheTooltipSection
              status={promptCache}
              pingState={pingState}
              onPing={onPingPromptCache ? handlePing : null}
              pingDisabled={pingDisabled}
            />
          ) : null}
          <ProviderUsageTooltipSection view={providerUsageView} activeProviderId={provider} />
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
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  skeletonLabel: {
    width: 22,
    height: theme.fontSize.base,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  tooltipContent: {
    gap: theme.spacing[1.5],
    minWidth: 200,
  },
  tooltipTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
  tooltipDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  tooltipDivider: {
    height: 1,
    backgroundColor: theme.colors.borderAccent,
    marginVertical: theme.spacing[1],
    // Cancel the tooltip content's horizontal padding so the rule spans edge to edge.
    marginHorizontal: -theme.spacing[2],
  },
  promptCacheStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    // Pin the row so swapping Warm for Likely expired cannot move the lines below it.
    minHeight: theme.fontSize.base * 1.4,
  },
  promptCacheDot: {
    width: theme.spacing[1.5],
    height: theme.spacing[1.5],
    borderRadius: theme.borderRadius.full,
  },
  promptCacheDotWarm: {
    backgroundColor: theme.colors.statusSuccess,
  },
  promptCacheDotExpiring: {
    backgroundColor: theme.colors.statusWarning,
  },
  promptCacheDotExpired: {
    backgroundColor: theme.colors.statusDanger,
  },
  promptCacheDotUnknown: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  promptCachePingRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: theme.spacing[0.5],
  },
  promptCachePingHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
    // Two lines either way, so swapping the hint for the failure keeps the height.
    minHeight: theme.fontSize.sm * 1.4 * 2,
  },
  promptCachePingError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
    minHeight: theme.fontSize.sm * 1.4 * 2,
  },
}));
