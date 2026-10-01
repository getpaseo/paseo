import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { HostFilter } from "@/components/hosts/host-filter";
import { useMemo, type ReactElement } from "react";
import type { UsageDisplay } from "./display";
import { UsageOptionsMenu } from "./options-menu";
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
 * host, and the options menu. A host that cannot report usage keeps only the host filter.
 */
export function UsageControls({
  view,
  display,
  onRefresh,
  hostSelection,
}: {
  view: UsageView;
  display: UsageDisplay;
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
        <UsageOptionsMenu display={display} busy={busy} onRefresh={onRefresh} />
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
 * One host's usage and the title-row controls that go with it, for the Usage screen and the
 * compact usage sheet.
 */
export function useHostUsageWithControls(
  hostSelection: UsageHostSelection,
  display: UsageDisplay,
): { view: UsageView; refresh: () => void; controls: ReactElement } {
  const { view, refresh } = useHostUsage(hostSelection.serverId);
  const controls = useMemo(
    () => (
      <UsageControls
        view={view}
        display={display}
        onRefresh={refresh}
        hostSelection={hostSelection}
      />
    ),
    [display, hostSelection, refresh, view],
  );
  return { view, refresh, controls };
}
