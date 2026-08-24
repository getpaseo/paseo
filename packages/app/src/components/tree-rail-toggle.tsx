import { useMemo } from "react";
import { Pressable, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { FolderTree } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  paneContentToolbarIconSize,
  paneContentToolbarIconButtonStyle,
} from "@/components/ui/pane-content-toolbar";
import type { Theme } from "@/styles/theme";

const ThemedFolderTree = withUnistyles(FolderTree);
const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * Opens and closes a `TreeRail`. Every panel that owns a tree rail uses this one
 * button so the affordance reads the same wherever the rail appears; only the
 * flag it drives is per-panel.
 */
export function TreeRailToggle({
  visible,
  testID,
  onToggle,
}: {
  visible: boolean;
  testID: string;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const label = t(visible ? "workspace.tree.hideFolderTree" : "workspace.tree.showFolderTree");
  const buttonStyle = useMemo(
    () => (state: { hovered?: boolean; pressed: boolean }) =>
      paneContentToolbarIconButtonStyle(state, visible),
    [visible],
  );
  const accessibilityState = useMemo(() => ({ selected: visible }), [visible]);
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={accessibilityState}
          aria-selected={visible}
          testID={testID}
          style={buttonStyle}
          onPress={onToggle}
        >
          <ThemedFolderTree size={paneContentToolbarIconSize(false)} uniProps={iconColorMapping} />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
