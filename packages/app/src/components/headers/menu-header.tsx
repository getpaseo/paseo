import type { ReactNode } from "react";
import { Text } from "react-native";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { Menu, PanelLeft } from "lucide-react-native";
import { ScreenHeader } from "./screen-header";
import { HeaderToggleButton } from "./header-toggle-button";
import { usePanelStore } from "@/stores/panel-store";

interface MenuHeaderProps {
  title?: string;
  rightContent?: ReactNode;
}

export function MenuHeader({ title, rightContent }: MenuHeaderProps) {
  const { theme } = useUnistyles();
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopAgentListOpen = usePanelStore((state) => state.desktop.agentListOpen);
  const toggleAgentList = usePanelStore((state) => state.toggleAgentList);

  const isOpen = isMobile ? mobileView === "agent-list" : desktopAgentListOpen;
  const MenuIcon = isMobile ? Menu : PanelLeft;
  const menuIconColor = !isMobile && isOpen
    ? theme.colors.foreground
    : theme.colors.foregroundMuted;

  return (
    <ScreenHeader
      left={
        <>
          <HeaderToggleButton
            onPress={toggleAgentList}
            tooltipLabel="Toggle sidebar"
            tooltipKeys={["mod", "B"]}
            tooltipSide="right"
            testID="menu-button"
            nativeID="menu-button"
            accessible
            accessibilityRole="button"
            accessibilityLabel={isOpen ? "Close menu" : "Open menu"}
            accessibilityState={{ expanded: isOpen }}
          >
            <MenuIcon size={isMobile ? 20 : 16} color={menuIconColor} />
          </HeaderToggleButton>
          {title && (
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
          )}
        </>
      }
      right={rightContent}
      leftStyle={styles.left}
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
}));
