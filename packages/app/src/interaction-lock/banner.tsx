import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Lock } from "lucide-react-native";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Theme } from "@/styles/theme";
import { useToast } from "@/contexts/toast-context";
import { useInteractionLocked } from "@/stores/interaction-lock-store";
import { unlockInteractionScreen } from "./actions";

const ThemedLock = withUnistyles(Lock);
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * Whole-app interaction lock chrome while locked.
 * Lock entry lives in the workspace ⋮ menu — no floating lock FAB.
 * Unlock: banner control (biometric/device credential on Android when enabled).
 */
export function InteractionLockBanner() {
  const locked = useInteractionLocked();
  const { t } = useTranslation();
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);

  const handleUnlock = useCallback(() => {
    if (busy) return;
    setBusy(true);
    void unlockInteractionScreen({
      promptMessage: t("interactionLock.authPrompt"),
      cancelLabel: t("common.actions.cancel"),
    })
      .then((result) => {
        if (result.status === "failed") {
          toast.error(t("interactionLock.unlockFailed"));
        }
        return undefined;
      })
      .finally(() => {
        setBusy(false);
      });
  }, [busy, t, toast]);

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
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={t("interactionLock.unlock")}
          style={[styles.unlockButton, busy && styles.buttonDisabled]}
          testID="interaction-lock-unlock"
          hitSlop={8}
        >
          {busy ? (
            <ActivityIndicator size="small" />
          ) : (
            <Text style={styles.unlockText}>{t("interactionLock.unlock")}</Text>
          )}
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
    minWidth: 64,
    alignItems: "center",
    justifyContent: "center",
  },
  unlockText: {
    color: theme.colors.foreground,
    fontSize: 13,
    fontWeight: "600",
  },
  buttonDisabled: {
    opacity: 0.6,
  },
}));
