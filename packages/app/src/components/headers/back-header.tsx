import type { ReactNode } from "react";
import { Pressable } from "react-native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ArrowLeft } from "lucide-react-native";
import { ScreenHeader } from "./screen-header";
import { ScreenTitle } from "./screen-title";

interface BackHeaderProps {
  title?: string;
  titleAccessory?: ReactNode;
  rightContent?: ReactNode;
  onBack?: () => void;
}

export function BackHeader({ title, titleAccessory, rightContent, onBack }: BackHeaderProps) {
  const { theme } = useUnistyles();

  return (
    <ScreenHeader
      left={
        <>
          <Pressable
            onPress={onBack ?? (() => router.back())}
            style={styles.backButton}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <ArrowLeft size={theme.iconSize.lg} color={theme.colors.foregroundMuted} />
          </Pressable>
          {title && <ScreenTitle>{title}</ScreenTitle>}
          {titleAccessory}
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
}));
