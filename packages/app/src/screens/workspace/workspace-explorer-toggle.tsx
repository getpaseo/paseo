import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { PanelRight } from "lucide-react-native";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { WINDOW_NO_DRAG_DATASET } from "@/components/desktop/titlebar-drag-region";
import { HeaderToggleButton, headerIconSlotStyle } from "@/components/headers/header-toggle-button";
import { SidebarCloseButton } from "@/components/headers/sidebar-close-button";
import {
  extraMutedIconColorMapping,
  iconButtonChromeGlyphSize,
  mutedIconColorMapping,
} from "@/components/ui/icon-button-chrome";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import { useHasWindowChromeObstruction } from "@/utils/desktop-window";
import type { ShortcutKey } from "@/utils/format-shortcut";

const ThemedPanelRight = withUnistyles(PanelRight);

const EXPLORER_TOGGLE_KEYS: ShortcutKey[] = ["mod", "E"];

interface WorkspaceExplorerToggleProps {
  onPress: () => void;
  label: string;
  tooltipLabel: string;
  accessibilityState: { expanded: boolean };
  mobile: boolean;
  style?: StyleProp<ViewStyle>;
}

function WorkspaceExplorerToggle({
  onPress,
  label,
  tooltipLabel,
  accessibilityState,
  mobile,
  style,
}: WorkspaceExplorerToggleProps) {
  return (
    <HeaderToggleButton
      testID="workspace-explorer-toggle"
      onPress={onPress}
      tooltipLabel={tooltipLabel}
      tooltipKeys={EXPLORER_TOGGLE_KEYS}
      tooltipSide="left"
      style={style}
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
    >
      <ThemedPanelRight
        size={iconButtonChromeGlyphSize("large")}
        strokeWidth={1.5}
        uniProps={mobile ? mutedIconColorMapping : extraMutedIconColorMapping}
      />
    </HeaderToggleButton>
  );
}

export function useWorkspaceExplorerControls({
  hasWorkspace,
  compact,
  focusMode,
  expanded,
  onToggle,
}: {
  hasWorkspace: boolean;
  compact: boolean;
  focusMode: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const hasLeadingWindowControls = useHasWindowChromeObstruction("top-left");
  const inDesktopTitlebar = hasLeadingWindowControls && hasWorkspace && !compact && !focusMode;

  return useMemo(() => {
    const props = {
      label: expanded
        ? t("workspace.tabs.explorerSidebar.close")
        : t("workspace.tabs.explorerSidebar.open"),
      tooltipLabel: t("workspace.tabs.explorerSidebar.toggle"),
      onPress: onToggle,
      accessibilityState: { expanded },
    };

    if (inDesktopTitlebar) {
      // Keep the button in the header Tab order. The active rail carves its slot out of the drag region.
      const headerSlot = expanded ? null : (
        <View
          pointerEvents="none"
          style={[headerIconSlotStyle.slot, styles.headerAction]}
          dataSet={WINDOW_NO_DRAG_DATASET}
        />
      );
      return {
        inDesktopTitlebar,
        headerAction: headerSlot,
        compactAction: headerSlot,
        dockAction: (
          <View
            pointerEvents="none"
            style={[headerIconSlotStyle.slot, styles.dockAction]}
            dataSet={WINDOW_NO_DRAG_DATASET}
          />
        ),
        titlebarAction: (
          <View pointerEvents="box-none" style={styles.titlebarSlot}>
            <WorkspaceExplorerToggle {...props} mobile={false} />
          </View>
        ),
      };
    }

    return {
      inDesktopTitlebar,
      headerAction: compact ? null : (
        <WorkspaceExplorerToggle {...props} mobile={false} style={styles.headerAction} />
      ),
      compactAction: <WorkspaceExplorerToggle {...props} mobile />,
      dockAction: compact ? (
        <SidebarCloseButton
          label={props.label}
          onPress={onToggle}
          testID="workspace-explorer-toggle"
          accessibilityState={props.accessibilityState}
        />
      ) : null,
      titlebarAction: null,
    };
  }, [compact, expanded, inDesktopTitlebar, onToggle, t]);
}

const styles = StyleSheet.create((theme) => ({
  headerAction: {
    marginRight: { xs: 0, md: -theme.spacing[2] },
  },
  dockAction: {
    // The dock divider is absolutely positioned. Match the other headers' content center.
    marginBottom: theme.borderWidth[1],
  },
  titlebarSlot: {
    position: "absolute",
    top: 0,
    right: theme.spacing[1],
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    // Center with the bordered workspace header and Explorer tabs row.
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: "transparent",
    justifyContent: "center",
    zIndex: 1,
  },
}));
