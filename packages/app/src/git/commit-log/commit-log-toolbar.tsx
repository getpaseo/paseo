import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { RotateCw } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { CommitLogScope } from "@getpaseo/protocol/messages";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { extraMutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import {
  PaneContentToolbar,
  ToolbarButton,
  ToolbarControls,
  paneContentToolbarIconSize,
} from "@/components/ui/pane-content-toolbar";
import { SegmentedControl } from "@/components/ui/segmented-control";

const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

interface CommitLogToolbarProps {
  scope: CommitLogScope;
  onScopeChange: (scope: CommitLogScope) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  compact: boolean;
}

export function CommitLogToolbar({
  scope,
  onScopeChange,
  onRefresh,
  isRefreshing,
  compact,
}: CommitLogToolbarProps) {
  const { t } = useTranslation();
  const scopeOptions = useMemo(
    () => [
      {
        value: "head" as const,
        label: t("panels.commitLog.scope.head"),
        testID: "commit-log-scope-head",
      },
      {
        value: "all" as const,
        label: t("panels.commitLog.scope.all"),
        testID: "commit-log-scope-all",
      },
    ],
    [t],
  );

  return (
    <PaneContentToolbar testID="commit-log-toolbar">
      <SegmentedControl
        options={scopeOptions}
        value={scope}
        onValueChange={onScopeChange}
        size="sm"
        testID="commit-log-scope"
      />
      <ToolbarControls>
        <ToolbarButton
          label={isRefreshing ? t("panels.commitLog.refreshing") : t("panels.commitLog.refresh")}
          compact={compact}
          disabled={isRefreshing}
          testID="commit-log-refresh"
          onPress={onRefresh}
        >
          {isRefreshing ? (
            <ThemedLoadingSpinner
              size={paneContentToolbarIconSize(compact)}
              uniProps={extraMutedIconColorMapping}
            />
          ) : (
            <ThemedRotateCw
              size={paneContentToolbarIconSize(compact)}
              uniProps={extraMutedIconColorMapping}
            />
          )}
        </ToolbarButton>
      </ToolbarControls>
    </PaneContentToolbar>
  );
}
