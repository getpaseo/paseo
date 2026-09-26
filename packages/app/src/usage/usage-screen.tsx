import { useCallback } from "react";
import { useIsFocused } from "@react-navigation/native";
import { router } from "expo-router";
import { PageLayout } from "@/components/page-layout";
import { usageCopy } from "./copy";
import type { UsageHostGroup } from "./model";
import { useUsageByHost } from "./queries";
import { UsageMessage, UsageSection } from "./usage-section";

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
  return (
    <PageLayout title={usageCopy.title} onBack={leaveUsage} testID="usage-screen">
      {isFocused ? <UsageScreenContent /> : null}
    </PageLayout>
  );
}

function UsageScreenContent() {
  const { groups, refresh } = useUsageByHost();
  return (
    <>
      {groups.length === 0 ? <UsageMessage text={usageCopy.noHosts} /> : null}
      {groups.map((group) => (
        <HostUsageGroup key={group.serverId} group={group} onRefresh={refresh} />
      ))}
    </>
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
