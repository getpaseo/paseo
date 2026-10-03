import { RotateCw } from "lucide-react-native";
import { useCallback, useMemo } from "react";
import { Text, View, type StyleProp, type TextStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  extraMutedIconColorMapping,
  iconButtonChromeGlyphSize,
  smallIconButtonChromeFrameSize,
} from "@/components/ui/icon-button-chrome";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import { UsageBalanceBar } from "./balance-bar";
import { usageCopy } from "./copy";
import type { UsageDisplay } from "./display";
import { formatUsageFreshness, type UsageRefresh } from "./model";
import { useReportRefresh } from "./queries";
import { UsageSourceIcon } from "./source-icon";
import type { UsageReport, UsageReportEntry, UsageWindow } from "./types";
import { UsageWindowBar } from "./window-bar";

function statusText(report: UsageReport): string | null {
  if (report.status === "available") return null;
  return report.status === "error" ? "Error" : "Unavailable";
}

function reportContent(report: UsageReport) {
  if (report.status === "available")
    return {
      windows: report.windows,
      balances: report.balances ?? [],
      details: report.details ?? [],
      message: undefined,
    };
  const message =
    report.status === "unavailable" ? usageCopy.problem(report.problem) : report.error;
  return { windows: [], balances: [], details: [], message };
}

const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

export function UsageCard({
  serverId,
  entry,
  display,
  pinnable,
  refreshable,
  compact = false,
}: {
  serverId: string;
  entry: UsageReportEntry;
  display: UsageDisplay;
  /** Whether each window row pins the window to the sidebar. */
  pinnable: boolean;
  /** Whether the header has a Refresh button. Without one the freshness shows on the card. */
  refreshable: boolean;
  compact?: boolean;
}) {
  const isCompact = useIsCompactFormFactor();
  const { refresh, refreshState } = useReportRefresh(serverId, entry.id);
  // Where there is no hover the freshness is printed on the card; elsewhere the Refresh tooltip.
  const showsFreshnessInline = isNative || isCompact || !refreshable;
  const usage = entry.report;
  const status = statusText(usage);
  const footer = entry.account.label ?? null;
  const { windows, balances, details, message } = reportContent(usage);

  const containerStyle = useMemo(
    () => [styles.container, compact ? styles.containerCompact : styles.containerPadded],
    [compact],
  );
  const dotStyle = useMemo(
    () => [
      styles.statusDot,
      usage.status === "available" && styles.statusDotAvailable,
      usage.status === "error" && styles.statusDotError,
    ],
    [usage.status],
  );

  return (
    <View style={containerStyle} testID={`usage-report-${entry.id}`}>
      <View style={styles.header}>
        <UsageSourceIcon svg={entry.icon ?? null} size={14} />
        <Text style={styles.name} numberOfLines={1}>
          {entry.sourceLabel}
        </Text>
        {usage.status === "available" && usage.planLabel ? (
          <StatusBadge label={usage.planLabel} variant="muted" size="xs" />
        ) : null}
        <View style={styles.headerSpacer} />
        {status ? (
          <View style={styles.statusRow}>
            <View style={dotStyle} />
            <Text style={styles.statusLabel}>{status}</Text>
          </View>
        ) : null}
        {refreshable ? (
          <UsageRefreshButton
            sourceLabel={entry.sourceLabel}
            fetchedAt={entry.fetchedAt}
            refreshState={refreshState}
            onRefresh={refresh}
            compact={isCompact}
          />
        ) : null}
      </View>

      {message ? (
        <Text style={styles.error} numberOfLines={3}>
          {message}
        </Text>
      ) : null}

      {windows.length > 0 || balances.length > 0 ? (
        <View style={styles.bars}>
          {windows.map((window) => (
            <CardWindowBar
              key={window.id}
              entry={entry}
              window={window}
              display={display}
              pinnable={pinnable}
            />
          ))}
          {balances.map((balance) => (
            <UsageBalanceBar key={balance.id} balance={balance} />
          ))}
        </View>
      ) : null}

      {details.length > 0 ? (
        <View style={styles.details}>
          {details.map((detail) => (
            <View key={detail.id} style={styles.detailRow}>
              <Text style={styles.detailLabel} numberOfLines={1}>
                {detail.label}
              </Text>
              <Text style={styles.detailValue} numberOfLines={1}>
                {detail.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {footer || showsFreshnessInline ? (
        <View style={styles.footerRow}>
          <Text style={styles.footer} numberOfLines={1}>
            {footer}
          </Text>
          {showsFreshnessInline ? (
            <UsageFreshness
              fetchedAt={entry.fetchedAt}
              style={styles.freshness}
              testID="usage-freshness"
            />
          ) : null}
        </View>
      ) : null}

      {refreshState === "failed" ? (
        <Text style={styles.error} testID="usage-refresh-error">
          {usageCopy.refreshFailed}
        </Text>
      ) : null}
    </View>
  );
}

function CardWindowBar({
  entry,
  window,
  display,
  pinnable,
}: {
  entry: UsageReportEntry;
  window: UsageWindow;
  display: UsageDisplay;
  pinnable: boolean;
}) {
  const pin = useMemo(
    () => ({ sourceId: entry.sourceId, windowId: window.id }),
    [entry.sourceId, window.id],
  );
  const { togglePin } = display;
  const toggle = useCallback(() => togglePin(pin), [pin, togglePin]);
  return (
    <UsageWindowBar
      window={window}
      displayAs={display.displayAs}
      pinnable={pinnable}
      pinned={display.isPinned(pin)}
      onTogglePin={toggle}
      pinLabel={`${usageCopy.pin} ${entry.sourceLabel} ${window.label}`}
      pinTestID={`usage-pin-${entry.sourceId}-${window.id}`}
    />
  );
}

/** Refreshes this one report. Its tooltip says when the report on screen was fetched. */
function UsageRefreshButton({
  sourceLabel,
  fetchedAt,
  refreshState,
  onRefresh,
  compact,
}: {
  sourceLabel: string;
  fetchedAt: string;
  refreshState: UsageRefresh;
  onRefresh: () => void;
  compact: boolean;
}) {
  const isPending = refreshState === "pending";
  const iconSize = paneContentToolbarIconSize(compact);
  const freshness = useMemo(
    () => (
      <UsageFreshness
        fetchedAt={fetchedAt}
        style={styles.tooltipText}
        testID="usage-freshness-tooltip"
      />
    ),
    [fetchedAt],
  );
  return (
    <ToolbarButton
      label={`${usageCopy.refresh} ${sourceLabel}`}
      tooltip={freshness}
      tooltipSide="top"
      compact={compact}
      disabled={isPending}
      onPress={onRefresh}
      style={compact ? styles.refreshButtonCompact : styles.refreshButton}
      testID="usage-refresh"
    >
      {isPending ? (
        <ThemedLoadingSpinner size={iconSize} uniProps={extraMutedIconColorMapping} />
      ) : (
        <ThemedRotateCw size={iconSize} uniProps={extraMutedIconColorMapping} />
      )}
    </ToolbarButton>
  );
}

/** Its own component so the relative-time clock re-renders one `<Text>`, not the card. */
function UsageFreshness({
  fetchedAt,
  style,
  testID,
}: {
  fetchedAt: string;
  style: StyleProp<TextStyle>;
  testID: string;
}) {
  const elapsed = useCompactTimeAgo(new Date(fetchedAt));
  return (
    <Text style={style} numberOfLines={1} testID={testID}>
      {formatUsageFreshness(elapsed)}
    </Text>
  );
}

// The Refresh glyph lands on the card's right rail and the header keeps its text height;
// the button's larger hitbox overhangs both instead of pushing them.
function iconHitboxOverhang(compact: boolean) {
  const overhang =
    (smallIconButtonChromeFrameSize(compact) - iconButtonChromeGlyphSize("small", compact)) / 2;
  return { marginRight: -overhang, marginVertical: -overhang };
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[3],
  },
  // The gap is one step under the card padding: window rows add their own vertical padding.
  containerPadded: {
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  containerCompact: {
    gap: theme.spacing[3],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  name: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  headerSpacer: {
    flex: 1,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.foregroundMuted,
  },
  statusDotAvailable: {
    backgroundColor: theme.colors.statusSuccess,
  },
  statusDotError: {
    backgroundColor: theme.colors.statusDanger,
  },
  statusLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  // Window rows carry their own vertical padding, which already separates them.
  bars: {
    gap: theme.spacing[1],
  },
  details: {
    gap: theme.spacing[1],
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  detailLabel: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  detailValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  footer: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  freshness: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tooltipText: {
    color: theme.colors.popoverForeground,
    fontSize: theme.fontSize.sm,
  },
  refreshButton: iconHitboxOverhang(false),
  refreshButtonCompact: iconHitboxOverhang(true),
}));
