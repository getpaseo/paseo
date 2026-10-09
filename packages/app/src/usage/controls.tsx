import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { HostFilter } from "@/components/hosts/host-filter";
import { useMemo, type ReactElement } from "react";
import { UsageRefreshButton } from "./refresh-button";
import { UsageOptions } from "./options";
import type { UsageHost } from "./model";
import { useHostUsage } from "./queries";
import type { UsageView } from "./types";

/** The hosts to choose between, and which one is shown. */
export interface UsageHostSelection {
  hosts: UsageHost[];
  serverId: string;
  onSelect: (serverId: string) => void;
}

/**
 * The controls on the right of every usage title row: the host filter when there is more than one
 * host, Refresh all, and the Settings cog. A host that cannot report usage keeps only the host filter.
 */
export function UsageControls({
  view,
  onRefresh,
  hostSelection,
}: {
  view: UsageView;
  onRefresh: () => void;
  hostSelection?: UsageHostSelection;
}) {
  const busy = view.kind === "loading" || (view.kind === "ready" && view.isRefreshing);
  return (
    <View style={styles.controls}>
      {hostSelection && hostSelection.hosts.length > 1 ? (
        <HostFilter
          hosts={hostSelection.hosts}
          selectedHost={hostSelection.serverId}
          onSelectHost={hostSelection.onSelect}
          includeAllHost={false}
          triggerTestID="usage-host-filter-trigger"
          hostOptionTestID={usageHostOptionTestID}
        />
      ) : null}
      {view.kind === "unavailable" ? null : (
        <>
          <UsageRefreshButton busy={busy} onRefresh={onRefresh} />
          <UsageOptions />
        </>
      )}
    </View>
  );
}

function usageHostOptionTestID(serverId: string): string {
  return `usage-host-filter-item-${serverId}`;
}

const styles = StyleSheet.create((theme) => ({
  controls: {
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));

/**
 * One host's usage and the title-row controls that go with it, for the Usage modal.
 */
export function useHostUsageWithControls(hostSelection: UsageHostSelection): {
  view: UsageView;
  refresh: () => void;
  controls: ReactElement;
} {
  const { view, refresh } = useHostUsage(hostSelection.serverId);
  const controls = useMemo(
    () => <UsageControls view={view} onRefresh={refresh} hostSelection={hostSelection} />,
    [hostSelection, refresh, view],
  );
  return { view, refresh, controls };
}
