import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { UsageCard } from "./card";
import type { UsageDisplay } from "./display";
import { useUsageInSidebar } from "./in-sidebar";
import type { UsageReportEntry } from "./types";

/** One card per report (source + account). Window rows pin while the sidebar summary is on. */
export function UsageList({
  serverId,
  reports,
  display,
}: {
  serverId: string;
  reports: UsageReportEntry[];
  display: UsageDisplay;
}) {
  const { inSidebar } = useUsageInSidebar();
  return (
    <View style={styles.list}>
      {reports.map((entry) => (
        <View key={entry.id} style={settingsStyles.card}>
          <UsageCard
            serverId={serverId}
            entry={entry}
            display={display}
            pinnable={inSidebar}
            refreshable
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[3],
  },
}));
