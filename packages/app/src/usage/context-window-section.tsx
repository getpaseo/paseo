import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { UsageCard } from "./card";
import { useUsagePreferences } from "./display";
import { useHostUsage } from "./queries";

/** The current host's available plan limits inside the context-window tooltip. */
export function ContextWindowUsageTooltip({ serverId }: { serverId: string }) {
  const { view } = useHostUsage(serverId);
  const { display } = useUsagePreferences(serverId);
  if (view.kind !== "ready" || view.reports.length === 0) return null;

  return (
    <>
      <View style={styles.divider} />
      <View style={styles.reports}>
        {view.reports.map((entry) => (
          <UsageCard key={entry.id} serverId={serverId} entry={entry} display={display} compact />
        ))}
      </View>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  divider: {
    height: 1,
    backgroundColor: theme.colors.borderAccent,
    marginVertical: theme.spacing[2],
    marginHorizontal: -theme.spacing[2],
  },
  reports: {
    alignSelf: "stretch",
    gap: theme.spacing[3],
  },
}));
