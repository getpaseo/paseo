import { useIsFocused } from "@react-navigation/native";
import { router } from "expo-router";
import { useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { PageLayout } from "@/components/page-layout";
import { useHostUsageWithControls } from "./controls";
import { usageCopy } from "./copy";
import { useUsagePreferences } from "./display";
import { useUsageHostSelection } from "./hosts";
import type { UsageHost } from "./model";
import { UsageBody, UsageMessage } from "./usage-section";

// The screen is reachable by URL, so there may be no history to go back to.
function leaveUsage(): void {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace("/");
}

export function UsageScreen() {
  const isFocused = useIsFocused();
  if (!isFocused) return <UsagePage>{null}</UsagePage>;
  return <FocusedUsageScreen />;
}

function UsagePage({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  return (
    <PageLayout title={usageCopy.title} onBack={leaveUsage} actions={actions} testID="usage-screen">
      {children}
    </PageLayout>
  );
}

function FocusedUsageScreen() {
  const { serverId, connectedHosts, select } = useUsageHostSelection();
  if (!serverId) {
    return (
      <UsagePage>
        <UsageMessage text={usageCopy.noHosts} />
      </UsagePage>
    );
  }
  return (
    <HostUsage key={serverId} serverId={serverId} hosts={connectedHosts} onSelectHost={select} />
  );
}

function HostUsage({
  serverId,
  hosts,
  onSelectHost,
}: {
  serverId: string;
  hosts: UsageHost[];
  onSelectHost: (serverId: string) => void;
}) {
  const { display } = useUsagePreferences();
  const hostSelection = useMemo(
    () => ({ hosts, serverId, onSelect: onSelectHost }),
    [hosts, onSelectHost, serverId],
  );
  const { view, refresh, controls } = useHostUsageWithControls(hostSelection);
  return (
    <UsagePage actions={controls}>
      <View testID={`usage-host-${serverId}`}>
        <UsageBody serverId={serverId} view={view} display={display} onRefresh={refresh} />
      </View>
    </UsagePage>
  );
}
