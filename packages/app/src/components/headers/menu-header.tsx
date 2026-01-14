import type { ReactNode } from "react";
import { Pressable, Text } from "react-native";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { Menu, PanelLeft } from "lucide-react-native";
import { ScreenHeader } from "./screen-header";
import { useSidebarStore } from "@/stores/sidebar-store";

interface MenuHeaderProps {
  title?: string;
  rightContent?: ReactNode;
}

export function MenuHeader({ title, rightContent }: MenuHeaderProps) {
  const { theme } = useUnistyles();
  const { isOpen, toggle } = useSidebarStore();
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";

  const MenuIcon = isMobile ? Menu : PanelLeft;
  const menuIconColor = !isMobile && isOpen
    ? theme.colors.foreground
    : theme.colors.foregroundMuted;

  return (
    <ScreenHeader
      left={
        <>
          <Pressable onPress={toggle} style={styles.menuButton}>
            <MenuIcon size={16} color={menuIconColor} />
          </Pressable>
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
  menuButton: {
    padding: {
      xs: theme.spacing[3],
      md: theme.spacing[2],
    },
    borderRadius: theme.borderRadius.lg,
  },
  title: {
    flex: 1,
    fontSize: theme.fontSize.lg,
    fontWeight: {
      xs: theme.fontWeight.semibold,
      md: "400",
    },
    color: theme.colors.foreground,
  },
}));
