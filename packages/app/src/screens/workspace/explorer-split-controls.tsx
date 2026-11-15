import { Rows2, X } from "lucide-react-native";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { ResizeHandle } from "@/components/resize-handle";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import {
  extraMutedIconColorMapping,
  iconButtonChromeGlyphSize,
  mutedIconColorMapping,
} from "@/components/ui/icon-button-chrome";
import { WorkspaceTabPresentationResolver } from "@/screens/workspace/workspace-tab-presentation";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  EXPLORER_SPLIT_HEADER_HEIGHT,
  type ExplorerSplitDivider,
} from "@/screens/workspace/use-explorer-split";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

const ThemedRows2 = withUnistyles(Rows2);
const ThemedX = withUnistyles(X);

const DIVIDER_GROUP_ID = "explorer-split";

export function ExplorerSplitButton({
  canSplit,
  isSplit,
  onPress,
}: {
  canSplit: boolean;
  isSplit: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys("toggle-explorer-split");
  const label = isSplit
    ? t("workspace.tabs.explorerSidebar.unsplit")
    : t("workspace.tabs.explorerSidebar.split");
  const disabled = !isSplit && !canSplit;
  const accessibilityState = useMemo(() => ({ selected: isSplit, disabled }), [disabled, isSplit]);
  return (
    <HeaderToggleButton
      testID="workspace-explorer-split-toggle"
      onPress={onPress}
      disabled={disabled}
      tooltipLabel={label}
      tooltipKeys={shortcutKeys?.[0] ?? []}
      tooltipSide="bottom"
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
    >
      <ThemedRows2
        size={iconButtonChromeGlyphSize("large")}
        strokeWidth={1.5}
        uniProps={isSplit ? mutedIconColorMapping : extraMutedIconColorMapping}
      />
    </HeaderToggleButton>
  );
}

/** The bottom half's title bar, drawn in the gap the host leaves above the bottom slot. */
export function ExplorerSplitBottomHeader({
  tab,
  top,
  serverId,
  workspaceId,
  onUnsplit,
}: {
  tab: WorkspaceTabDescriptor;
  top: number;
  serverId: string;
  workspaceId: string;
  onUnsplit: () => void;
}) {
  const { t } = useTranslation();
  const unsplitLabel = t("workspace.tabs.explorerSidebar.unsplit");
  return (
    <View
      style={[styles.header, inlineUnistylesStyle({ top })]}
      testID="explorer-split-bottom-header"
    >
      <WorkspaceTabPresentationResolver tab={tab} serverId={serverId} workspaceId={workspaceId}>
        {(presentation) => (
          <Text numberOfLines={1} style={styles.title}>
            {presentation.label}
          </Text>
        )}
      </WorkspaceTabPresentationResolver>
      <ToolbarButton
        testID="explorer-split-unsplit"
        label={unsplitLabel}
        compact
        onPress={onUnsplit}
      >
        <ThemedX size={14} strokeWidth={1.5} uniProps={mutedIconColorMapping} />
      </ToolbarButton>
    </View>
  );
}

export function ExplorerSplitDividerHandle({ divider }: { divider: ExplorerSplitDivider }) {
  return (
    <View style={[styles.divider, inlineUnistylesStyle({ top: divider.top })]}>
      <ResizeHandle
        testID="explorer-split-divider"
        direction="vertical"
        groupId={DIVIDER_GROUP_ID}
        index={0}
        sizes={divider.sizes}
        containerSize={divider.containerSize}
        onPreviewResizeSplit={divider.onPreview}
        onResizeSplit={divider.onCommit}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    position: "absolute",
    left: 0,
    right: 0,
    height: EXPLORER_SPLIT_HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  divider: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 10,
  },
}));
