import type { ReactNode } from "react";
import { Pressable, Text } from "react-native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ArrowLeft } from "lucide-react-native";
import { ScreenHeader } from "./screen-header";

interface BackHeaderProps {
  title?: string;
  rightContent?: ReactNode;
  onBack?: () => void;
}

export function BackHeader({ title, rightContent, onBack }: BackHeaderProps) {
  const { theme } = useUnistyles();

  return (
    <ScreenHeader
      left={
        <>
          <Pressable
            onPress={onBack ?? (() => router.back())}
            style={styles.backButton}
          >
            <ArrowLeft size={20} color={theme.colors.mutedForeground} />
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
  backButton: {
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
