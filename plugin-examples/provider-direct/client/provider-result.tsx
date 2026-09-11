import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { z } from "zod";
import { providerResultSchema } from "../shared/provider-result";

type ProviderResultData = z.output<typeof providerResultSchema>;

export function ProviderResult({ item, theme }: PluginTimelineItemProps<ProviderResultData>) {
  const styles = useMemo(
    () => ({
      card: {
        gap: 4,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: 12,
        backgroundColor: theme.colors.surface1,
      },
      label: { color: theme.colors.accent, fontWeight: "600" as const },
      detail: { color: theme.colors.foreground },
    }),
    [theme],
  );

  return (
    <View style={styles.card}>
      <Text style={styles.label}>{item.data.label}</Text>
      <Text style={styles.detail}>{item.data.detail}</Text>
    </View>
  );
}
