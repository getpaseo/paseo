import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

interface ScreenHeaderProps {
  left?: ReactNode;
  right?: ReactNode;
  leftStyle?: StyleProp<ViewStyle>;
  rightStyle?: StyleProp<ViewStyle>;
}

/**
 * Shared frame for the home/back headers so we only maintain padding, border,
 * and safe-area logic in one place.
 */
export function ScreenHeader({ left, right, leftStyle, rightStyle }: ScreenHeaderProps) {
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();

  return (
    <View style={styles.header}>
      <View style={[styles.inner, { paddingTop: insets.top + 12 }]}>
        <View style={styles.row}>
          <View style={[styles.left, leftStyle]}>{left}</View>
          <View style={[styles.right, rightStyle]}>{right}</View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    backgroundColor: theme.colors.background,
  },
  inner: {},
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  left: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
