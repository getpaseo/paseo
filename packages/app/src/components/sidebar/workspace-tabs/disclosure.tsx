import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { bySizing } from "@/components/ui/control-geometry";
import { isWeb } from "@/constants/platform";
import { densityIconProps } from "@/styles/density";
import type { Theme } from "@/styles/theme";
import { toggleSidebarWorkspaceTabs, useIsSidebarWorkspaceTabsExpanded } from "./expansion";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const iconProps = densityIconProps("sm", (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));
const iconHoveredProps = densityIconProps("sm", (theme: Theme) => ({
  color: theme.colors.foreground,
}));

const POINTER_SIZE = 18;
/** Keeps a press aimed at the button beside it from landing on the disclosure. */
const POINTER_GAP = 8;
/** Pointer-only: the width the disclosure adds to the hover scrim, like the archive button. */
export const TABS_DISCLOSURE_POINTER_FOOTPRINT = POINTER_SIZE + POINTER_GAP;

function disclosureStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.button, hovered && styles.buttonHovered];
}

/** Shows or hides a workspace's open tabs under its sidebar row. */
export function SidebarWorkspaceTabsDisclosure({ workspaceKey }: { workspaceKey: string }) {
  const { t } = useTranslation();
  const expanded = useIsSidebarWorkspaceTabsExpanded(workspaceKey);
  const handlePress = useCallback(() => toggleSidebarWorkspaceTabs(workspaceKey), [workspaceKey]);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const Chevron = expanded ? ThemedChevronDown : ThemedChevronRight;
  const renderIcon = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => (
      <Chevron uniProps={hovered ? iconHoveredProps : iconProps} />
    ),
    [Chevron],
  );
  return (
    <PressHighlight
      hitSlop={4}
      style={disclosureStyle}
      onPress={handlePress}
      accessibilityRole={isWeb ? undefined : "button"}
      accessibilityState={accessibilityState}
      aria-expanded={expanded}
      accessibilityLabel={
        expanded ? t("sidebar.workspace.actions.hideTabs") : t("sidebar.workspace.actions.showTabs")
      }
      testID={`sidebar-workspace-tabs-disclosure-${workspaceKey}`}
    >
      {renderIcon}
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Pointer: the archive button's box. Touch: the kebab's box, centred on the same 20px title
  // line, sitting flush against the kebab's hit area.
  button: {
    width: bySizing({ touch: 32, pointer: POINTER_SIZE }),
    height: bySizing({ touch: 32, pointer: POINTER_SIZE }),
    marginTop: bySizing({ touch: -6, pointer: 0 }),
    marginRight: bySizing({ touch: 0, pointer: POINTER_GAP }),
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
  },
  buttonHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
