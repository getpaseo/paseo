import { useTranslation } from "react-i18next";
import { RotateCw } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import {
  mutedIconColorMapping,
  useIconButtonChromeGlyphSize,
} from "@/components/ui/icon-button-chrome";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";

const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

/**
 * Refreshes every report on the host; spins while a refresh is in flight. On compact it sits in the
 * header's island, so its highlight is round.
 */
export function UsageRefreshButton({ busy, onRefresh }: { busy: boolean; onRefresh: () => void }) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const iconSize = useIconButtonChromeGlyphSize("small", compact);
  return (
    <ToolbarButton
      label={t("providerUsage.refreshAll")}
      compact={compact}
      disabled={busy}
      onPress={onRefresh}
      testID="usage-refresh-all"
    >
      {busy ? (
        <ThemedLoadingSpinner size={iconSize} uniProps={mutedIconColorMapping} />
      ) : (
        <ThemedRotateCw size={iconSize} uniProps={mutedIconColorMapping} />
      )}
    </ToolbarButton>
  );
}
