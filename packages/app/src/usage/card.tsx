import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { StatusBadge } from "@/components/ui/status-badge";
import { UsageBalanceBar } from "./balance-bar";
import { UsageSourceIcon } from "./source-icon";
import type { UsageReport, UsageReportEntry } from "./types";
import { UsageWindowBar } from "./window-bar";

function statusText(report: UsageReport): string | null {
  if (report.status === "available") return null;
  return report.status === "error" ? "Error" : "Unavailable";
}

export function UsageCard({
  entry,
  compact = false,
}: {
  entry: UsageReportEntry;
  compact?: boolean;
}) {
  const usage = entry.report;
  const status = statusText(usage);
  const footer = usage.account.label ?? null;
  const balances = usage.balances ?? [];
  const details = usage.details ?? [];

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
    <View style={containerStyle}>
      <View style={styles.header}>
        <UsageSourceIcon svg={entry.icon ?? null} size={14} />
        <Text style={styles.name} numberOfLines={1}>
          {entry.sourceLabel}
        </Text>
        {usage.planLabel ? <StatusBadge label={usage.planLabel} variant="muted" /> : null}
        <View style={styles.headerSpacer} />
        {status ? (
          <View style={styles.statusRow}>
            <View style={dotStyle} />
            <Text style={styles.statusLabel}>{status}</Text>
          </View>
        ) : null}
      </View>

      {usage.error ? (
        <Text style={styles.error} numberOfLines={3}>
          {usage.error}
        </Text>
      ) : null}

      {usage.windows.length > 0 || balances.length > 0 ? (
        <View style={styles.bars}>
          {usage.windows.map((window) => (
            <UsageWindowBar key={window.id} window={window} />
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

      {footer ? (
        <Text style={styles.footer} numberOfLines={1}>
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[3],
  },
  containerPadded: {
    gap: theme.spacing[4],
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
  bars: {
    gap: theme.spacing[3],
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
  footer: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
