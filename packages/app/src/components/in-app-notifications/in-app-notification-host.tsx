import { useCallback, useState, useEffect } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { createPortal } from "react-dom";
import { inAppNotificationStore } from "./in-app-notification-store";
import { InAppNotificationCard } from "./in-app-notification-card";
import type { InAppNotificationItem } from "./types";
import { getOverlayRoot, OVERLAY_Z } from "@/lib/overlay-root";
import { isWeb } from "@/constants/platform";

export function InAppNotificationHost() {
  const [notifications, setNotifications] = useState<InAppNotificationItem[]>([]);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    setNotifications(inAppNotificationStore.getNotifications());
    const unsubscribe = inAppNotificationStore.subscribe(() => {
      setNotifications([...inAppNotificationStore.getNotifications()]);
    });
    return unsubscribe;
  }, []);

  const handleDismiss = useCallback((id: string) => {
    inAppNotificationStore.dismiss(id);
  }, []);

  if (notifications.length === 0) {
    return null;
  }

  const containerStyle = [
    styles.container,
    {
      top: insets.top + 12,
      right: insets.right + 12,
    },
  ];

  const content = (
    <View style={containerStyle} pointerEvents="box-none">
      {notifications.map((notification) => (
        <InAppNotificationCard
          key={notification.id}
          notification={notification}
          onDismiss={handleDismiss}
        />
      ))}
    </View>
  );

  if (isWeb && typeof document !== "undefined") {
    return createPortal(content, getOverlayRoot());
  }

  return content;
}

const styles = StyleSheet.create(() => ({
  container: {
    position: "absolute",
    zIndex: OVERLAY_Z.toast + 100,
    alignItems: "flex-end",
    pointerEvents: "box-none",
  },
}));
