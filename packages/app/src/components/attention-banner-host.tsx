import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { Eye } from "lucide-react-native";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import {
  useAttentionBannerStore,
  type AttentionBannerPayload,
} from "@/stores/attention-banner-store";
import { buildNotificationRoute } from "@/utils/notification-routing";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { getOverlayRoot, OVERLAY_Z } from "@/lib/overlay-root";
import type { Theme } from "@/styles/theme";

const AUTO_DISMISS_MS = 5000;
const ThemedEye = withUnistyles(Eye);
const mutedIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface PeekedNotification {
  title: string;
  body?: string;
}

/**
 * Center-top attention banner for when the user is in Paseo but on the wrong agent/terminal.
 * Includes a peek action that shows the notification body in a read-only modal without
 * navigating away or marking the underlying agent attention as seen.
 */
export function AttentionBannerHost() {
  const banner = useAttentionBannerStore((state) => state.banner);
  const dismiss = useAttentionBannerStore((state) => state.dismiss);
  const router = useRouter();
  const isCompact = useIsCompactFormFactor();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [peeked, setPeeked] = useState<PeekedNotification | null>(null);

  useEffect(() => {
    if (!banner || peeked) {
      // Keep the banner stable while the user is peeking details.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
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
  }, [banner, dismiss, peeked]);

  const handleOpen = useCallback(
    (payload: AttentionBannerPayload) => {
      const route = buildNotificationRoute(payload.data);
      dismiss();
      router.navigate(route);
    },
    [dismiss, router],
  );

  const handlePress = useCallback(() => {
    if (!banner) {
      return;
    }
    handleOpen(banner);
  }, [banner, handleOpen]);

  const handlePeek = useCallback(() => {
    if (!banner) {
      return;
    }
    // Snapshot content only — do not navigate and do not clear agent attention.
    setPeeked({
      title: banner.title,
      body: banner.body,
    });
  }, [banner]);

  const handleClosePeek = useCallback(() => {
    setPeeked(null);
  }, []);

  const peekHeader = useMemo<SheetHeader>(
    () => ({
      title: peeked?.title ?? "Notification",
      onClose: handleClosePeek,
    }),
    [handleClosePeek, peeked?.title],
  );

  const containerStyle = useMemo(
    () => [styles.container, isCompact && styles.containerCompact],
    [isCompact],
  );

  const bannerContent = banner ? (
    <View pointerEvents="box-none" style={styles.host} testID="attention-banner-host">
      <View style={containerStyle} testID="attention-banner">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${banner.title}${banner.extraCount > 0 ? ` +${banner.extraCount}` : ""}`}
          onPress={handlePress}
          style={styles.mainPressable}
          testID="attention-banner-open"
        >
          <Text style={styles.title} numberOfLines={1}>
            {banner.title}
            {banner.extraCount > 0 ? ` +${banner.extraCount}` : ""}
          </Text>
          {banner.body ? (
            <Text style={styles.body} numberOfLines={2}>
              {banner.body}
            </Text>
          ) : null}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Peek notification"
          onPress={handlePeek}
          style={styles.peekButton}
          hitSlop={8}
          testID="attention-banner-peek"
        >
          <ThemedEye size={16} uniProps={mutedIconColor} />
        </Pressable>
      </View>
    </View>
  ) : null;

  const portalBanner =
    bannerContent && isWeb && typeof document !== "undefined"
      ? createPortal(bannerContent, getOverlayRoot())
      : bannerContent;

  return (
    <>
      {portalBanner}
      <AdaptiveModalSheet
        visible={peeked !== null}
        onClose={handleClosePeek}
        header={peekHeader}
        testID="attention-notification-peek"
      >
        <View style={styles.peekBody}>
          {peeked?.body ? (
            <Text style={styles.peekBodyText} selectable>
              {peeked.body}
            </Text>
          ) : (
            <Text style={styles.peekEmptyText}>No additional details.</Text>
          )}
          <Button
            variant="outline"
            onPress={handleClosePeek}
            testID="attention-notification-peek-close"
          >
            Close
          </Button>
        </View>
      </AdaptiveModalSheet>
    </>
  );
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
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  containerCompact: {
    maxWidth: 360,
  },
  mainPressable: {
    flex: 1,
    minWidth: 0,
  },
  peekButton: {
    minWidth: 28,
    minHeight: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
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
  peekBody: {
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[6],
    paddingBottom: theme.spacing[4],
  },
  peekBodyText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  peekEmptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
