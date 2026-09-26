import { Fragment } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { UsageCard } from "./card";
import type { UsageReportEntry } from "./types";

export function UsageList({ reports }: { reports: UsageReportEntry[] }) {
  return (
    <View style={settingsStyles.card}>
      {reports.map((entry, index) => (
        <Fragment key={`${entry.sourceId}:${entry.report.account.key}`}>
          {index > 0 ? <View style={styles.divider} /> : null}
          <UsageCard entry={entry} />
        </Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  divider: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
}));
