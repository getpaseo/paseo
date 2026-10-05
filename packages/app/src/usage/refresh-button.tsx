import { RotateCw } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { extraMutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usageCopy } from "./copy";

const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

/** Refreshes every report on the host; spins while a refresh is in flight. */
export function UsageRefreshButton({ busy, onRefresh }: { busy: boolean; onRefresh: () => void }) {
  const compact = useIsCompactFormFactor();
  const iconSize = paneContentToolbarIconSize(compact);
  return (
    <ToolbarButton
      label={usageCopy.refreshAll}
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
  );
}
