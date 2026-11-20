import { useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable } from "react-native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ArrowLeft } from "lucide-react-native";
import { ScreenHeader } from "./screen-header";
import { ScreenTitle } from "./screen-title";
import { CompactHeader } from "./compact-header";
import { useIsCompactFormFactor } from "@/constants/layout";

interface BackHeaderProps {
  title?: string;
  rightContent?: ReactNode;
  onBack?: () => void;
}

function goBack(): void {
  router.back();
}

export function BackHeader({ title, rightContent, onBack }: BackHeaderProps) {
  const isCompact = useIsCompactFormFactor();
  if (isCompact) {
    return <CompactHeader navigation="back" title={title} onBack={onBack} actions={rightContent} />;
  }
  return <DesktopBackHeader title={title} rightContent={rightContent} onBack={onBack} />;
}

function DesktopBackHeader({ title, rightContent, onBack }: BackHeaderProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const handleBack = useCallback(() => {
    if (onBack) {
      onBack();
      return;
    }
    goBack();
  }, [onBack]);

  return (
    <ScreenHeader
      left={
        <>
          <Pressable
            onPress={handleBack}
            style={styles.backButton}
            accessibilityRole="button"
            accessibilityLabel={t("common.actions.back")}
          >
            <ArrowLeft size={theme.iconSize.lg} color={theme.colors.foregroundMuted} />
          </Pressable>
          {title && <ScreenTitle>{title}</ScreenTitle>}
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
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
}));
