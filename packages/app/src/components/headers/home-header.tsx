import { useCallback, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Settings, MessageSquare, MoreVertical, Plus } from "lucide-react-native";
import { ScreenHeader } from "./screen-header";

interface HomeHeaderProps {
  onCreateAgent: () => void;
  onImportAgent: () => void;
}

export function HomeHeader({ onCreateAgent, onImportAgent }: HomeHeaderProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [isMenuVisible, setIsMenuVisible] = useState(false);

  const openMenu = useCallback(() => setIsMenuVisible(true), []);
  const closeMenu = useCallback(() => setIsMenuVisible(false), []);
  const handleImportPress = useCallback(() => {
    closeMenu();
    onImportAgent();
  }, [closeMenu, onImportAgent]);

  return (
    <>
      <ScreenHeader
        left={
          <Pressable
            onPress={() => router.push("/settings")}
            style={styles.iconButton}
          >
            <Settings size={20} color={theme.colors.foreground} />
          </Pressable>
        }
        right={
          <>
            <Pressable
              onPress={() => router.push("/orchestrator")}
              style={styles.iconButton}
            >
              <MessageSquare size={20} color={theme.colors.foreground} />
            </Pressable>
            <Pressable onPress={onCreateAgent} style={styles.iconButton}>
              <Plus size={20} color={theme.colors.foreground} />
            </Pressable>
            <Pressable onPress={openMenu} style={styles.iconButton}>
              <MoreVertical size={20} color={theme.colors.foreground} />
            </Pressable>
          </>
        }
      />

      <Modal
        visible={isMenuVisible}
        transparent
        animationType="fade"
        onRequestClose={closeMenu}
      >
        <View style={styles.menuOverlay}>
          <Pressable style={styles.menuBackdrop} onPress={closeMenu} />
          <View
            style={[
              styles.menuContainer,
              {
                top: insets.top + theme.spacing[4],
                right: theme.spacing[3],
              },
            ]}
          >
            <Pressable style={styles.menuItem} onPress={handleImportPress}>
              <Text style={styles.menuItemText}>Import Agent</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  iconButton: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  menuOverlay: {
    flex: 1,
  },
  menuBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  menuContainer: {
    position: "absolute",
    minWidth: 180,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.background,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  menuItem: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  menuItemText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
}));
