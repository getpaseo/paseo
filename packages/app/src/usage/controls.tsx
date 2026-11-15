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
 * The controls on the right of every usage title row: Refresh all and the Settings cog. A host
 * that cannot report usage has none.
 */
export function UsageControls({
  view,
  serverId,
  onRefresh,
}: {
  view: UsageView;
  serverId: string;
  onRefresh: () => void;
}) {
  const busy = view.kind === "loading" || (view.kind === "ready" && view.isRefreshing);
  if (view.kind === "unavailable") return null;
  return (
    <View style={styles.controls}>
      {view.kind === "off" ? null : <UsageRefreshButton busy={busy} onRefresh={onRefresh} />}
      <UsageOptions serverId={serverId} />
    </View>
  );
}

/** The host whose usage shows, when there is more than one to choose from. */
function UsageHostFilter({ hostSelection }: { hostSelection: UsageHostSelection }) {
  return (
    <HostFilter
      hosts={hostSelection.hosts}
      selectedHost={hostSelection.serverId}
      onSelectHost={hostSelection.onSelect}
      includeAllHost={false}
      hang
      triggerTestID="usage-host-filter-trigger"
      hostOptionTestID={usageHostOptionTestID}
    />
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
 * One host’s usage for the Usage modal: its title-row controls, null when there is nothing to
 * control so the header leaves no empty island, and the host filter for the top of the body, null
 * with a single host.
 */
export function useHostUsageWithControls(hostSelection: UsageHostSelection): {
  view: UsageView;
  refresh: () => void;
  controls: ReactElement | null;
  hostFilter: ReactElement | null;
} {
  const { view, refresh } = useHostUsage(hostSelection.serverId);
  const controls = useMemo(
    () =>
      view.kind === "unavailable" ? null : (
        <UsageControls serverId={hostSelection.serverId} view={view} onRefresh={refresh} />
      ),
    [hostSelection.serverId, refresh, view],
  );
  const hostFilter = useMemo(
    () =>
      hostSelection.hosts.length > 1 ? <UsageHostFilter hostSelection={hostSelection} /> : null,
    [hostSelection],
  );
  return { view, refresh, controls, hostFilter };
}
