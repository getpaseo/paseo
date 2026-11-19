import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMemo, type ReactElement } from "react";
import { UsageRefreshButton } from "./refresh-button";
import { UsageOptions } from "./options";
import { hasHostChoice, type UsageHostSelection } from "./hosts";
import { useHostUsage } from "./queries";
import type { UsageView } from "./types";

/**
 * The controls on the right of every usage title row: Refresh all and the Settings cog. A host
 * that cannot report usage has none, unless there is another host to switch to: the host choice
 * lives in the cog, so the cog stays.
 */
export function UsageControls({
  view,
  serverId,
  onRefresh,
  hostSelection,
}: {
  view: UsageView;
  serverId: string;
  onRefresh: () => void;
  hostSelection?: UsageHostSelection;
}) {
  const busy = view.kind === "loading" || (view.kind === "ready" && view.isRefreshing);
  if (!hasUsageControls(view, hostSelection)) return null;
  return (
    <View style={styles.controls}>
      {view.kind === "off" || view.kind === "unavailable" ? null : (
        <UsageRefreshButton busy={busy} onRefresh={onRefresh} />
      )}
      <UsageOptions serverId={serverId} hostSelection={hostSelection} />
    </View>
  );
}

function hasUsageControls(view: UsageView, hostSelection: UsageHostSelection | undefined): boolean {
  return view.kind !== "unavailable" || hasHostChoice(hostSelection);
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
 * One host’s usage for the Usage modal, and its title-row controls: null when there is nothing to
 * control, so the header leaves no empty island.
 */
export function useHostUsageWithControls(hostSelection: UsageHostSelection): {
  view: UsageView;
  refresh: () => void;
  controls: ReactElement | null;
} {
  const { view, refresh } = useHostUsage(hostSelection.serverId);
  const controls = useMemo(
    () =>
      hasUsageControls(view, hostSelection) ? (
        // Keyed by host, so state one host's controls hold, such as a failed setting change,
        // never shows on another's.
        <UsageControls
          key={hostSelection.serverId}
          serverId={hostSelection.serverId}
          view={view}
          onRefresh={refresh}
          hostSelection={hostSelection}
        />
      ) : null,
    [hostSelection, refresh, view],
  );
  return { view, refresh, controls };
}
