import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Lock } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Theme } from "@/styles/theme";
import { useInteractionLocked, useInteractionLockStore } from "@/stores/interaction-lock-store";

const ThemedLock = withUnistyles(Lock);
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * Quiet center-top chip shown while interaction lock is on.
 * Tap Unlock to restore full control. Navigation remains available.
 */
export function InteractionLockBanner() {
  const locked = useInteractionLocked();
  const setLocked = useInteractionLockStore((state) => state.setLocked);
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();

  const handleUnlock = useCallback(() => {
    setLocked(false);
  }, [setLocked]);

  if (!locked) {
    return null;
  }

  return (
    <View
      pointerEvents="box-none"
      style={[styles.host, { top: Math.max(insets.top, 8) + (isCompact ? 4 : 8) }]}
    >
      <View
        style={styles.banner}
        accessibilityRole="summary"
        accessibilityLabel={t("interactionLock.lockedA11y")}
        testID="interaction-lock-banner"
      >
        <ThemedLock size={14} uniProps={mutedIcon} />
        <Text style={styles.bannerText}>{t("interactionLock.banner")}</Text>
        <Pressable
          onPress={handleUnlock}
          accessibilityRole="button"
          accessibilityLabel={t("interactionLock.unlock")}
          style={styles.unlockButton}
          testID="interaction-lock-unlock"
          hitSlop={8}
        >
          <Text style={styles.unlockText}>{t("interactionLock.unlock")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  host: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 50,
    alignItems: "center",
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.popover,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    maxWidth: "92%",
  },
  bannerText: {
    color: theme.colors.foregroundMuted,
    fontSize: 13,
    fontWeight: "500",
  },
  unlockButton: {
    marginLeft: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.secondary,
  },
  unlockText: {
    color: theme.colors.foreground,
    fontSize: 13,
    fontWeight: "600",
  },
}));
