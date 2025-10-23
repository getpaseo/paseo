import { View, Pressable } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Settings, MessageSquare, Plus } from "lucide-react-native";

interface HomeHeaderProps {
  onCreateAgent: () => void;
}

export function HomeHeader({ onCreateAgent }: HomeHeaderProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.header}>
      <View style={{ paddingTop: insets.top + 12 }}>
        <View style={styles.headerRow}>
          {/* Left side - Settings */}
          <View style={styles.headerLeft}>
            <Pressable
              onPress={() => router.push("/settings")}
              style={styles.iconButton}
            >
              <Settings size={20} color={theme.colors.foreground} />
            </Pressable>
          </View>

          {/* Right side - Activity and New Agent */}
          <View style={styles.headerRight}>
            <Pressable
              onPress={() => router.push("/orchestrator")}
              style={styles.iconButton}
            >
              <MessageSquare size={20} color={theme.colors.foreground} />
            </Pressable>
            <Pressable onPress={onCreateAgent} style={styles.iconButton}>
              <Plus size={20} color={theme.colors.foreground} />
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    backgroundColor: theme.colors.background,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  iconButton: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
}));
