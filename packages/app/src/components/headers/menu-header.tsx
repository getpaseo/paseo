import type { ReactNode } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { PanelLeft } from "lucide-react-native";
import { ScreenHeader } from "./screen-header";
import { HeaderToggleButton } from "./header-toggle-button";
import { usePanelStore } from "@/stores/panel-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getShortcutOs } from "@/utils/shortcut-platform";

interface MenuHeaderProps {
  title?: string;
  rightContent?: ReactNode;
  borderless?: boolean;
}

interface SidebarMenuToggleProps {
  style?: StyleProp<ViewStyle>;
  tooltipSide?: "left" | "right" | "top" | "bottom";
  testID?: string;
  nativeID?: string;
}

const MOBILE_MENU_LINE_WIDTH = 16;
const MOBILE_MENU_LINE_SHORT_WIDTH = 8;
const MOBILE_MENU_LINE_HEIGHT = 2;

function MobileMenuIcon({ color }: { color: string }) {
  return (
    <View style={styles.mobileMenuIcon} pointerEvents="none">
      <View style={[styles.mobileMenuLine, { backgroundColor: color }]} />
      <View style={[styles.mobileMenuLine, { backgroundColor: color }]} />
      <View
        style={[styles.mobileMenuLine, styles.mobileMenuLineShort, { backgroundColor: color }]}
      />
    </View>
  );
}

export function SidebarMenuToggle({
  style,
  tooltipSide = "right",
  testID = "menu-button",
  nativeID = "menu-button",
}: SidebarMenuToggleProps = {}) {
  const { theme } = useUnistyles();
  const isMobile = useIsCompactFormFactor();
  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopAgentListOpen = usePanelStore((state) => state.desktop.agentListOpen);
  const toggleAgentList = usePanelStore((state) => state.toggleAgentList);
  const toggleShortcutKeys = getShortcutOs() === "mac" ? ["mod", "B"] : ["mod", "."];

  const isOpen = isMobile ? mobileView === "agent-list" : desktopAgentListOpen;
  const menuIconColor =
    !isMobile && isOpen ? theme.colors.foreground : theme.colors.foregroundMuted;

  return (
    <HeaderToggleButton
      onPress={toggleAgentList}
      tooltipLabel="Toggle sidebar"
      tooltipKeys={toggleShortcutKeys}
      tooltipSide={tooltipSide}
      testID={testID}
      nativeID={nativeID}
      style={style}
      accessible
      accessibilityRole="button"
      accessibilityLabel={isOpen ? "Close menu" : "Open menu"}
      accessibilityState={{ expanded: isOpen }}
    >
      {isMobile ? (
        <MobileMenuIcon color={menuIconColor} />
      ) : (
        <PanelLeft size={theme.iconSize.md} color={menuIconColor} />
      )}
    </HeaderToggleButton>
  );
}

export function MenuHeader({ title, rightContent, borderless }: MenuHeaderProps) {
  return (
    <ScreenHeader
      left={
        <>
          <SidebarMenuToggle />
          {title && (
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
          )}
        </>
      }
      right={rightContent}
      leftStyle={styles.left}
      borderless={borderless}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  left: {
    gap: theme.spacing[2],
  },
  title: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontWeight: {
      xs: "400",
      md: "300",
    },
    color: theme.colors.foreground,
  },
  mobileMenuIcon: {
    width: MOBILE_MENU_LINE_WIDTH,
    height: 12,
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  mobileMenuLine: {
    width: MOBILE_MENU_LINE_WIDTH,
    height: MOBILE_MENU_LINE_HEIGHT,
    borderRadius: theme.borderRadius.full,
  },
  mobileMenuLineShort: {
    width: MOBILE_MENU_LINE_SHORT_WIDTH,
  },
}));
