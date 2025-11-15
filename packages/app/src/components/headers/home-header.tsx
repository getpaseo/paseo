import { Pressable } from "react-native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Settings, MessageSquare, Plus } from "lucide-react-native";
import { ScreenHeader } from "./screen-header";

interface HomeHeaderProps {
  onCreateAgent: () => void;
}

export function HomeHeader({ onCreateAgent }: HomeHeaderProps) {
  const { theme } = useUnistyles();

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
          <Pressable onPress={onCreateAgent} style={styles.iconButton}>
            <Plus size={20} color={theme.colors.foreground} />
          </Pressable>
        </>
      }
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  iconButton: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
}));
