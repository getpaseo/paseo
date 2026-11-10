import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, type PressableStateCallbackType } from "react-native";
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

/** Room for a two-digit count, so the button keeps its width as tabs open and close. */
const COUNT_WIDTH = 16;
const POINTER_CHEVRON_BOX = 18;
const TOUCH_CHEVRON_BOX = 32;
/** Keeps a press aimed at the button beside it from landing on the disclosure. */
const POINTER_GAP = 8;
/** Pointer-only: the width the disclosure adds to the hover scrim, like the archive button. */
export const TABS_DISCLOSURE_POINTER_FOOTPRINT = COUNT_WIDTH + POINTER_CHEVRON_BOX + POINTER_GAP;
/** Touch-only: the width a reserved slot keeps for the disclosure beside the kebab. */
export const TABS_DISCLOSURE_TOUCH_WIDTH = COUNT_WIDTH + TOUCH_CHEVRON_BOX;

/** Shows or hides a workspace's open tabs under its sidebar row, with how many there are. */
export function SidebarWorkspaceTabsDisclosure({
  workspaceKey,
  tabCount,
}: {
  workspaceKey: string;
  tabCount: number;
}) {
  const { t } = useTranslation();
  const expanded = useIsSidebarWorkspaceTabsExpanded(workspaceKey);
  const handlePress = useCallback(() => toggleSidebarWorkspaceTabs(workspaceKey), [workspaceKey]);
  return (
    <SidebarCountDisclosure
      variant="workspace"
      count={tabCount}
      expanded={expanded}
      onPress={handlePress}
      accessibilityLabel={
        expanded ? t("sidebar.workspace.actions.hideTabs") : t("sidebar.workspace.actions.showTabs")
      }
      testID={`sidebar-workspace-tabs-disclosure-${workspaceKey}`}
    />
  );
}

function workspaceDisclosureStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.button, hovered && styles.buttonHovered];
}

function tabDisclosureStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.tabButton, hovered && styles.buttonHovered];
}

/**
 * A count and a chevron that expand a list under a sidebar row. `workspace` lines up with the
 * workspace row's kebab and archive button; `tab` sits at the end of a tab row in its list.
 */
export function SidebarCountDisclosure({
  variant,
  count,
  expanded,
  onPress,
  accessibilityLabel,
  testID,
}: {
  variant: "workspace" | "tab";
  count: number;
  expanded: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  testID: string;
}) {
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const accessibilityValue = useMemo(() => ({ text: String(count) }), [count]);
  const Chevron = expanded ? ThemedChevronDown : ThemedChevronRight;
  const renderContent = useCallback(
    ({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => (
      <>
        <Text numberOfLines={1} style={hovered ? styles.countHovered : styles.count}>
          {count}
        </Text>
        <Chevron uniProps={hovered ? iconHoveredProps : iconProps} />
      </>
    ),
    [Chevron, count],
  );
  return (
    <PressHighlight
      hitSlop={4}
      style={variant === "workspace" ? workspaceDisclosureStyle : tabDisclosureStyle}
      onPress={onPress}
      accessibilityRole={isWeb ? undefined : "button"}
      accessibilityState={accessibilityState}
      accessibilityValue={accessibilityValue}
      aria-expanded={expanded}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      {renderContent}
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Pointer: the archive button's height. Touch: the kebab's box, centred on the same 20px title
  // line, sitting flush against the kebab's hit area. The count widens it on both.
  button: {
    width: bySizing({
      touch: TABS_DISCLOSURE_TOUCH_WIDTH,
      pointer: COUNT_WIDTH + POINTER_CHEVRON_BOX,
    }),
    height: bySizing({ touch: TOUCH_CHEVRON_BOX, pointer: POINTER_CHEVRON_BOX }),
    marginTop: bySizing({ touch: -6, pointer: 0 }),
    marginRight: bySizing({ touch: 0, pointer: POINTER_GAP }),
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[0.5],
    borderRadius: 4,
  },
  // A tab row has no kebab to line up with: the touch box fills the row's height instead.
  tabButton: {
    width: bySizing({
      touch: TABS_DISCLOSURE_TOUCH_WIDTH,
      pointer: COUNT_WIDTH + POINTER_CHEVRON_BOX,
    }),
    height: bySizing({ touch: TOUCH_CHEVRON_BOX, pointer: POINTER_CHEVRON_BOX }),
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[0.5],
    borderRadius: 4,
  },
  buttonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  count: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  countHovered: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontVariant: ["tabular-nums"],
  },
}));
