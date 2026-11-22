import { memo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentMetric } from "@getpaseo/protocol/agent-types";

/**
 * Label and value rows a provider reports for a session or a turn. The provider owns the words and
 * the tone; the list only lines them up.
 */
export const MetricsList = memo(function MetricsList({
  metrics,
  testID,
}: {
  metrics: AgentMetric[];
  testID?: string;
}) {
  return (
    <View style={styles.list} testID={testID}>
      {metrics.map((metric) => (
        <View key={metric.label} style={styles.row}>
          <Text style={styles.label} numberOfLines={1}>
            {metric.label}
          </Text>
          <Text style={[styles.value, toneStyle(metric.tone)]} numberOfLines={1}>
            {metric.value}
          </Text>
        </View>
      ))}
    </View>
  );
});

function toneStyle(tone: AgentMetric["tone"]) {
  switch (tone) {
    case "ok":
      return styles.ok;
    case "warning":
      return styles.warning;
    case "danger":
      return styles.danger;
    default:
      return null;
  }
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[1.5],
  },
  row: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[6],
  },
  label: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  value: {
    flex: 1,
    textAlign: "right",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
    fontVariant: ["tabular-nums"],
  },
  ok: { color: theme.colors.statusSuccess },
  warning: { color: theme.colors.statusWarning },
  danger: { color: theme.colors.statusDanger },
}));
