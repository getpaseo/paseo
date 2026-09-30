import { RotateCw } from "lucide-react-native";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HostSwitcher } from "@/components/hosts/host-switcher";
import { extraMutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useMemo, type ReactElement } from "react";
import { usageCopy } from "./copy";
import type { UsageDisplay } from "./display";
import { UsageDisplayToggle } from "./display-toggle";
import type { UsageHost } from "./model";
import { useHostUsage } from "./queries";
import type { UsageView } from "./types";

const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

/** The hosts to choose between, and which one is shown. */
export interface UsageHostSelection {
  hosts: UsageHost[];
  serverId: string;
  onSelect: (serverId: string) => void;
}

/**
 * The controls on the right of every usage title row: the host selector, which also names the
 * host shown, the used/remaining toggle and Refresh. A host that cannot report usage keeps only
 * the selector.
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
  const compact = useIsCompactFormFactor();
  const iconSize = paneContentToolbarIconSize(compact);
  return (
    <View style={styles.controls}>
      {hostSelection && hostSelection.hosts.length > 0 ? (
        <HostSwitcher
          hosts={hostSelection.hosts}
          value={hostSelection.serverId}
          onSelect={hostSelection.onSelect}
          title={usageCopy.host}
          accessibilityLabel={usageCopy.host}
          testID="usage-host-switcher"
        />
      ) : null}
      {view.kind === "unavailable" ? null : (
        <>
          <UsageDisplayToggle display={display} />
          {/* The Changes panel's refresh: an icon, with the label in its tooltip. */}
          <ToolbarButton
            label={busy ? usageCopy.refreshing : usageCopy.refresh}
            compact={compact}
            disabled={busy}
            onPress={onRefresh}
            testID="usage-refresh-all"
          >
            {busy ? (
              <ThemedLoadingSpinner size={iconSize} uniProps={extraMutedIconColorMapping} />
            ) : (
              <ThemedRotateCw size={iconSize} uniProps={extraMutedIconColorMapping} />
            )}
          </ToolbarButton>
        </>
      )}
    </View>
  );
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
