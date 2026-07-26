import { useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { useAttentionBannerStore } from "@/stores/attention-banner-store";
import { buildNotificationRoute } from "@/utils/notification-routing";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { getOverlayRoot, OVERLAY_Z } from "@/lib/overlay-root";

const AUTO_DISMISS_MS = 5000;

/**
 * Center-top attention banner for when the user is in Paseo but on the wrong agent/terminal.
 */
export function AttentionBannerHost() {
  const banner = useAttentionBannerStore((state) => state.banner);
  const dismiss = useAttentionBannerStore((state) => state.dismiss);
  const router = useRouter();
  const isCompact = useIsCompactFormFactor();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!banner) {
      return;
    }
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      dismiss();
    }, AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [banner, dismiss]);

  const handlePress = useCallback(() => {
    if (!banner) {
      return;
    }
    const route = buildNotificationRoute(banner.data);
    dismiss();
    router.navigate(route);
  }, [banner, dismiss, router]);

  const containerStyle = useMemo(
    () => [styles.container, isCompact && styles.containerCompact],
    [isCompact],
  );

  if (!banner) {
    return null;
  }

  const extraLabel = banner.extraCount > 0 ? ` +${banner.extraCount}` : "";

  const content = (
    <View pointerEvents="box-none" style={styles.host} testID="attention-banner-host">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${banner.title}${extraLabel}`}
        onPress={handlePress}
        style={containerStyle}
        testID="attention-banner"
      >
        <Text style={styles.title} numberOfLines={1}>
          {banner.title}
          {extraLabel}
        </Text>
        {banner.body ? (
          <Text style={styles.body} numberOfLines={2}>
            {banner.body}
          </Text>
        ) : null}
      </Pressable>
    </View>
  );

  if (isWeb && typeof document !== "undefined") {
    return createPortal(content, getOverlayRoot());
  }

  return content;
}

const styles = StyleSheet.create((theme) => ({
  host: {
    position: "absolute",
    top: theme.spacing[3],
    left: 0,
    right: 0,
    zIndex: OVERLAY_Z.toast + 1,
    alignItems: "center",
    pointerEvents: "box-none",
  },
  container: {
    maxWidth: 440,
    width: "90%",
    backgroundColor: theme.colors.popover,
    borderRadius: theme.borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  containerCompact: {
    maxWidth: 360,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  body: {
    marginTop: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
