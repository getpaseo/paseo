import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { getProviderIcon } from "@/components/provider-icons";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Theme } from "@/styles/theme";
import { ProviderUsageBalanceBar } from "./balance-bar";
import { formatAgo } from "./format";
import type { ProviderUsage } from "./types";
import { ProviderUsageWindowBar } from "./window-bar";

interface ProviderUsageIconProps {
  iconKey: string;
  size: number;
  color?: string;
}

function ProviderUsageIcon({ iconKey, size, color = "" }: ProviderUsageIconProps) {
  const Icon = getProviderIcon(iconKey);
  return <Icon size={size} color={color} />;
}

const ThemedProviderUsageIcon = withUnistyles(ProviderUsageIcon);

const foregroundIconColor = (theme: Theme) => ({ color: theme.colors.foreground });

function statusText(usage: ProviderUsage): string | null {
  if (usage.status === "available") return null;
  return usage.status === "error" ? "Error" : "Unavailable";
}

function footerText(usage: ProviderUsage): string | null {
  const updated = formatAgo(usage.fetchedAt);
  const parts = [usage.sourceLabel, updated ? `Updated ${updated}` : null].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function ProviderUsageCard({
  usage,
  compact = false,
}: {
  usage: ProviderUsage;
  compact?: boolean;
}) {
  const status = statusText(usage);
  const footer = footerText(usage);
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
        <ThemedProviderUsageIcon
          iconKey={usage.providerId}
          size={16}
          uniProps={foregroundIconColor}
        />
        <Text style={styles.name} numberOfLines={1}>
          {usage.displayName}
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
            <ProviderUsageWindowBar key={window.id} window={window} />
          ))}
          {balances.map((balance) => (
            <ProviderUsageBalanceBar key={balance.id} balance={balance} />
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
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  containerCompact: {
    gap: theme.spacing[2],
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
    fontSize: theme.fontSize.xs,
  },
  bars: {
    gap: theme.spacing[2],
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
    fontSize: theme.fontSize.xs,
  },
  detailValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.4,
  },
  footer: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
