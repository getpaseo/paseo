import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { UsageRefreshButton } from "./refresh-button";
import { UsageOptions } from "./options";
import { useUsageDisplay, type UsageDisplay } from "./display";
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
  display,
  onRefresh,
  hostSelection,
  optionsOpen,
  onOptionsOpenChange,
}: {
  view: UsageView;
  serverId: string;
  display?: UsageDisplay;
  onRefresh: () => void;
  hostSelection?: UsageHostSelection;
  optionsOpen?: boolean;
  onOptionsOpenChange?: (open: boolean) => void;
}) {
  const busy = view.kind === "loading" || (view.kind === "ready" && view.isRefreshing);
  if (!hasUsageControls(view, hostSelection)) return null;
  return (
    <View style={styles.controls}>
      {view.kind === "off" || view.kind === "unavailable" ? null : (
        <UsageRefreshButton busy={busy} onRefresh={onRefresh} />
      )}
      <UsageOptions
        serverId={serverId}
        hostSelection={hostSelection}
        reports={view.kind === "ready" ? view.reports : []}
        display={display}
        open={optionsOpen}
        onOpenChange={onOptionsOpenChange}
      />
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
  display: UsageDisplay;
  refresh: () => void;
  controls: ReactElement | null;
  openOptions: () => void;
} {
  const { view, refresh } = useHostUsage(hostSelection.serverId);
  const { display } = useUsageDisplay(view.kind === "ready" ? view.reports : []);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const openOptions = useCallback(() => setOptionsOpen(true), []);
  const controls = useMemo(
    () =>
      hasUsageControls(view, hostSelection) ? (
        // Keyed by host, so state one host's controls hold, such as a failed setting change,
        // never shows on another's.
        <UsageControls
          key={hostSelection.serverId}
          serverId={hostSelection.serverId}
          view={view}
          display={display}
          onRefresh={refresh}
          hostSelection={hostSelection}
          optionsOpen={optionsOpen}
          onOptionsOpenChange={setOptionsOpen}
        />
      ) : null,
    [display, hostSelection, optionsOpen, refresh, view],
  );
  return { view, display, refresh, controls, openOptions };
}
