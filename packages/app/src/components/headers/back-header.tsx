import { View, Pressable, Text } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ArrowLeft } from "lucide-react-native";

interface BackHeaderProps {
  title?: string;
  rightContent?: React.ReactNode;
}

export function BackHeader({ title, rightContent }: BackHeaderProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.header}>
      <View style={{ paddingTop: insets.top + 12 }}>
        <View style={styles.headerRow}>
          {/* Left side - Back button */}
          <View style={styles.headerLeft}>
            <Pressable
              onPress={() => router.back()}
              style={styles.backButton}
            >
              <ArrowLeft size={20} color={theme.colors.foreground} />
            </Pressable>
            {title && (
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
            )}
          </View>

          {/* Right side */}
          <View style={styles.headerRight}>
            {rightContent}
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
    gap: theme.spacing[3],
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  backButton: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  title: {
    flex: 1,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
}));
