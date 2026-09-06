import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Bell, X } from "lucide-react-native";
import type { InAppNotificationItem } from "./types";
import { buildNotificationRoute, resolveNotificationTarget } from "@/utils/notification-routing";
import {
  WEB_NOTIFICATION_CLICK_EVENT,
  type WebNotificationClickDetail,
} from "@/utils/os-notifications";

const ThemedBell = withUnistyles(Bell, (theme) => ({
  size: 16,
  color: theme.colors.foreground,
}));

const ThemedClose = withUnistyles(X, (theme) => ({
  size: 14,
  color: theme.colors.foregroundMuted,
}));

export function InAppNotificationCard({
  notification,
  onDismiss,
}: {
  notification: InAppNotificationItem;
  onDismiss: (id: string) => void;
}) {
  const [opacity] = useState(() => new Animated.Value(0));
  const [translateX] = useState(() => new Animated.Value(24));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remainingTimeRef = useRef<number>(notification.durationMs ?? 5000);
  const startTimeRef = useRef<number>(0);
  const [isHovered, setIsHovered] = useState(false);

  const animateOut = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = null;
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 0,
        duration: 160,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(translateX, {
        toValue: 24,
        duration: 160,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(() => {
      onDismiss(notification.id);
    });
  }, [notification.id, onDismiss, opacity, translateX]);

  const startTimer = useCallback(
    (timeMs: number) => {
      if (timeMs <= 0) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      startTimeRef.current = Date.now();
      timerRef.current = setTimeout(() => {
        animateOut();
      }, timeMs);
    },
    [animateOut],
  );

  const pauseTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      const elapsed = Date.now() - startTimeRef.current;
      remainingTimeRef.current = Math.max(500, remainingTimeRef.current - elapsed);
    }
  }, []);

  const resumeTimer = useCallback(() => {
    startTimer(remainingTimeRef.current);
  }, [startTimer]);

  const handlePointerEnter = useCallback(() => {
    setIsHovered(true);
    pauseTimer();
  }, [pauseTimer]);

  const handlePointerLeave = useCallback(() => {
    setIsHovered(false);
    resumeTimer();
  }, [resumeTimer]);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 200,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(translateX, {
        toValue: 0,
        duration: 200,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();

    const duration = notification.durationMs;
    if (duration !== null && duration !== undefined && duration > 0) {
      startTimer(duration);
    }

    return () => {
      clearTimeout(timerRef.current);
    };
  }, [notification.durationMs, opacity, startTimer, translateX]);

  const handleClick = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = null;
    const data = notification.data as Record<string, unknown> | undefined;
    const target = resolveNotificationTarget(data);
    const hasTarget =
      target.serverId !== null || target.agentId !== null || target.workspaceId !== null;

    if (hasTarget) {
      const dispatch = (globalThis as { dispatchEvent?: (event: Event) => boolean }).dispatchEvent;
      const CustomEventCtor = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent;

      let handled = false;
      if (typeof dispatch === "function" && CustomEventCtor) {
        const event = new CustomEventCtor<WebNotificationClickDetail>(
          WEB_NOTIFICATION_CLICK_EVENT,
          {
            detail: { data },
            cancelable: true,
          },
        );
        handled = !dispatch(event);
      }

      if (!handled) {
        const route = buildNotificationRoute(data);
        const loc = (globalThis as { location?: { assign?: (url: string) => void; href?: string } })
          .location;
        if (loc?.assign) {
          loc.assign(route);
        } else if (loc) {
          loc.href = route;
        }
      }
    }

    animateOut();
  }, [animateOut, notification.data]);

  const cardAnimatedStyle = useMemo(
    () => [
      styles.card,
      isHovered ? styles.cardHovered : null,
      {
        opacity,
        transform: [{ translateX }],
      },
    ],
    [isHovered, opacity, translateX],
  );

  return (
    <Animated.View
      style={cardAnimatedStyle}
      // @ts-ignore onPointerEnter/Leave supported on web DOM
      onPointerEnter={handlePointerEnter}
      // @ts-ignore
      onPointerLeave={handlePointerLeave}
    >
      <Pressable style={styles.content} onPress={handleClick} testID="in-app-notification-content">
        <View style={styles.iconContainer}>
          <ThemedBell />
        </View>
        <View style={styles.textContainer}>
          <Text style={styles.title} numberOfLines={1}>
            {notification.title}
          </Text>
          {notification.body ? (
            <Text style={styles.body} numberOfLines={2}>
              {notification.body}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <Pressable
        style={styles.closeButton}
        onPress={animateOut}
        hitSlop={8}
        accessibilityLabel="Close notification"
        testID="in-app-notification-close"
      >
        <ThemedClose />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    width: 320,
    maxWidth: "100%",
    backgroundColor: theme.colors.surface1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    flexDirection: "row",
    alignItems: "center",
    padding: theme.spacing[3],
    marginBottom: theme.spacing[2],
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 4,
    pointerEvents: "auto",
  },
  cardHovered: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface2,
  },
  content: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
  },
  iconContainer: {
    marginRight: theme.spacing[2],
    marginTop: 2,
  },
  textContainer: {
    flex: 1,
  },
  title: {
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.foreground,
    lineHeight: 18,
  },
  body: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    marginTop: 2,
    lineHeight: 16,
  },
  closeButton: {
    padding: theme.spacing[1],
    marginLeft: theme.spacing[1],
    alignSelf: "flex-start",
  },
}));
