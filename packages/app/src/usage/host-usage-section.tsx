import { usageCopy } from "./copy";
import { useHostUsage } from "./queries";
import { UsageSection } from "./usage-section";

/** A host's usage reports, for its settings page. */
export function HostUsageSection({ serverId }: { serverId: string }) {
  const { view, refresh } = useHostUsage(serverId);
  return (
    <UsageSection title={usageCopy.planUsage} view={view} onRefresh={refresh} testID="usage-card" />
  );
}
