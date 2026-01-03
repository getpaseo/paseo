import { useCallback } from "react";
import { Pressable } from "react-native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Settings, MessageSquare, Download, Plus } from "lucide-react-native";
import { ScreenHeader } from "./screen-header";

interface HomeHeaderProps {
  onCreateAgent: () => void;
  onImportAgent: () => void;
}

export function HomeHeader({ onCreateAgent, onImportAgent }: HomeHeaderProps) {
  const { theme } = useUnistyles();
  const handleCreatePress = useCallback(() => {
    onCreateAgent();
  }, [onCreateAgent]);
  const handleImportPress = useCallback(() => {
    onImportAgent();
  }, [onImportAgent]);

  return (
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
          <Pressable onPress={handleImportPress} style={styles.iconButton}>
            <Download size={20} color={theme.colors.foreground} />
          </Pressable>
          <Pressable onPress={handleCreatePress} style={styles.iconButton}>
            <Plus size={20} color={theme.colors.foreground} />
          </Pressable>
        </>
      }
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  iconButton: {
    padding: {
      xs: theme.spacing[3],
      md: theme.spacing[2],
    },
    borderRadius: theme.borderRadius.lg,
  },
}));
