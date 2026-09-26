import { useCallback } from "react";
import { ScrollView, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { usageCopy } from "./copy";
import type { UsageHostGroup } from "./model";
import { useUsageByHost } from "./queries";
import { UsageMessage, UsageSection } from "./usage-section";

export function UsageScreen() {
  const isFocused = useIsFocused();
  return (
    <View style={styles.container}>
      <MenuHeader title={usageCopy.title} />
      {isFocused ? <UsageScreenContent /> : null}
    </View>
  );
}

function UsageScreenContent() {
  const insets = useSafeAreaInsets();
  const { groups, refresh } = useUsageByHost();
  return (
    <ScrollView style={styles.scroll} testID="usage-screen">
      <View style={[styles.content, { paddingBottom: insets.bottom }]}>
        {groups.length === 0 ? <UsageMessage text={usageCopy.noHosts} /> : null}
        {groups.map((group) => (
          <HostUsageGroup key={group.serverId} group={group} onRefresh={refresh} />
        ))}
      </View>
    </ScrollView>
  );
}

function HostUsageGroup({
  group,
  onRefresh,
}: {
  group: UsageHostGroup;
  onRefresh: (serverId: string) => void;
}) {
  const handleRefresh = useCallback(() => onRefresh(group.serverId), [group.serverId, onRefresh]);
  return (
    <UsageSection
      title={group.label}
      view={group.view}
      onRefresh={handleRefresh}
      testID={`usage-host-${group.serverId}`}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: theme.spacing[4],
    paddingTop: theme.spacing[6],
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
  },
}));
