import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { Menu, PanelLeft } from "lucide-react-native";
import { ScreenHeader } from "./screen-header";
import { usePanelStore } from "@/stores/panel-store";

interface MenuHeaderProps {
  title?: string;
  subtitle?: string;
  rightContent?: ReactNode;
}

export function MenuHeader({ title, subtitle, rightContent }: MenuHeaderProps) {
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
          <Pressable onPress={toggleAgentList} style={styles.menuButton}>
            <MenuIcon size={isMobile ? 20 : 16} color={menuIconColor} />
          </Pressable>
          {title && (
            <View style={styles.titleContainer}>
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              {subtitle && (
                <Text style={styles.subtitle} numberOfLines={1}>
                  {subtitle}
                </Text>
              )}
            </View>
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
  menuButton: {
    padding: {
      xs: theme.spacing[3],
      md: theme.spacing[2],
    },
    borderRadius: theme.borderRadius.lg,
  },
  titleContainer: {
    flex: 1,
    gap: theme.spacing[0],
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: {
      xs: "400",
      md: "300",
    },
    color: theme.colors.foreground,
  },
  subtitle: {
    fontSize: 12,
    fontWeight: "300",
    color: theme.colors.foregroundMuted,
  },
}));
