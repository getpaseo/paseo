import {
  FloatingHeaderOverlay,
  useFloatingHeaderOverlayClearance,
} from "@/components/floating-header";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Platform,
  StyleSheet as NativeStyleSheet,
  Text,
  ToastAndroid,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SPACING, type Theme } from "@/styles/theme";
import { useTranslation } from "react-i18next";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react-native";
import { getOverlayRoot, OVERLAY_Z } from "@/lib/overlay-root";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
} from "@/constants/layout";

export type ToastVariant = "default" | "info" | "success" | "warning" | "error";

export interface ToastShowOptions {
  icon?: ReactNode;
  variant?: ToastVariant;
  durationMs?: number | null;
  nativeAndroid?: boolean;
  testID?: string;
  /** Runs once when this toast leaves the screen: timed out, dismissed, or replaced. */
  onDismiss?: () => void;
}

export interface ToastState {
  id: number;
  content: ReactNode;
  nativeMessage: string | null;
  icon?: ReactNode;
  variant: ToastVariant;
  durationMs: number | null;
  testID?: string;
  onDismiss?: () => void;
}

/** Dismisses the toast it was returned for; a no-op once another toast replaced it. */
export type DismissToast = () => void;

/**
 * Dismisses the toast with this ID, and does nothing once another toast replaced it. Without an
 * ID, it dismisses whichever toast is shown.
 */
export type DismissToastById = (id?: number) => void;

export interface ToastApi {
  show: (content: ReactNode, options?: ToastShowOptions) => DismissToast;
  copied: (label?: string) => void;
  error: (message: string) => void;
}

type ToastViewportPlacement = "app-shell" | "panel" | "sidebar";

const DEFAULT_DURATION_MS = 2200;
const noopDismiss: DismissToast = () => {};
const TOAST_MAX_WIDTH = 480;
/** How long a toast takes to fade in or out. */
export const TOAST_FADE_MS = 140;
const SIDEBAR_TOAST_INSET = SPACING[2];
const toastEntering = FadeIn.duration(TOAST_FADE_MS);
const toastExiting = FadeOut.duration(TOAST_FADE_MS);
const ThemedCheckCircle = withUnistyles(CheckCircle2);
const ThemedInfo = withUnistyles(Info);
const ThemedWarning = withUnistyles(AlertTriangle);
const foregroundIcon = (theme: Theme) => ({ color: theme.colors.foreground });
const infoIcon = (theme: Theme) => ({ color: theme.colors.palette.blue[300] });
const successIcon = (theme: Theme) => ({ color: theme.colors.primary });
const warningIcon = (theme: Theme) => ({ color: theme.colors.palette.amber[500] });
const errorIcon = (theme: Theme) => ({ color: theme.colors.destructive });

export function useToastHost(): {
  api: ToastApi;
  toast: ToastState | null;
  dismiss: DismissToastById;
} {
  const { t } = useTranslation();
  const [toast, setToastState] = useState<ToastState | null>(null);
  const toastRef = useRef<ToastState | null>(null);
  const idRef = useRef(0);

  const setToast = useCallback((next: ToastState | null) => {
    const previous = toastRef.current;
    if (previous === next) return;
    toastRef.current = next;
    setToastState(next);
    previous?.onDismiss?.();
  }, []);

  const dismiss = useCallback<DismissToastById>(
    (id) => {
      if (id === undefined || toastRef.current?.id === id) setToast(null);
    },
    [setToast],
  );

  const show = useCallback(
    (content: ReactNode, options?: ToastShowOptions): DismissToast => {
      const nativeMessage = typeof content === "string" ? content.trim() : null;
      if (!content || nativeMessage === "") {
        return noopDismiss;
      }

      const variant = options?.variant ?? "default";
      const durationMs =
        options?.durationMs === undefined ? DEFAULT_DURATION_MS : options.durationMs;
      const nativeAndroid = options?.nativeAndroid ?? false;

      if (Platform.OS === "android" && nativeAndroid && nativeMessage) {
        const duration =
          durationMs !== null && durationMs <= 2500 ? ToastAndroid.SHORT : ToastAndroid.LONG;
        ToastAndroid.showWithGravity(nativeMessage, duration, ToastAndroid.TOP);
        return noopDismiss;
      }

      idRef.current += 1;
      const id = idRef.current;
      setToast({
        id,
        content,
        nativeMessage,
        icon: options?.icon,
        variant,
        durationMs,
        testID: options?.testID,
        onDismiss: options?.onDismiss,
      });
      return () => dismiss(id);
    },
    [dismiss, setToast],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      copied: (label?: string) =>
        show(label ? t("common.states.copiedLabel", { label }) : t("common.states.copied"), {
          variant: "success",
          icon: <ThemedCheckCircle size={18} uniProps={foregroundIcon} />,
        }),
      error: (message: string) => show(message, { variant: "error", durationMs: 3200 }),
    }),
    [show, t],
  );

  return { api, toast, dismiss };
}

export function ToastViewport({
  toast,
  onDismiss,
  placement = "app-shell",
  onBottomCoverageChange,
}: {
  toast: ToastState | null;
  /** Called with the ID of the toast that timed out. */
  onDismiss: (id: number) => void;
  placement?: ToastViewportPlacement;
  /** Sidebar placement: reports the distance from the region's bottom edge to the toast's top. */
  onBottomCoverageChange?: (coverage: number) => void;
}) {
  const insets = useSafeAreaInsets();
  const isMobile = useIsCompactFormFactor();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissDeadlineRef = useRef<number | null>(null);
  const remainingDurationRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const scheduleDismiss = useCallback(
    (id: number, durationMs: number | null) => {
      clearTimer();
      if (durationMs === null) {
        remainingDurationRef.current = 0;
        dismissDeadlineRef.current = null;
        return;
      }
      const nextDurationMs = Math.max(0, durationMs);
      remainingDurationRef.current = nextDurationMs;
      dismissDeadlineRef.current = Date.now() + nextDurationMs;
      // A replacing toast is in the host before this viewport renders it and reschedules, so the
      // timer names its own toast rather than dismissing whichever one is current.
      timeoutRef.current = setTimeout(() => {
        onDismiss(id);
      }, nextDurationMs);
    },
    [onDismiss, clearTimer],
  );

  const pauseDismiss = useCallback(() => {
    if (dismissDeadlineRef.current !== null) {
      remainingDurationRef.current = Math.max(0, dismissDeadlineRef.current - Date.now());
    }
    dismissDeadlineRef.current = null;
    clearTimer();
  }, [clearTimer]);

  const resumeDismiss = useCallback(() => {
    if (!toast || toast.durationMs === null) {
      return;
    }
    scheduleDismiss(toast.id, remainingDurationRef.current || toast.durationMs);
  }, [scheduleDismiss, toast]);

  const toastId = toast?.id;
  const durationMs = toast?.durationMs ?? null;
  useEffect(() => {
    if (toastId === undefined) return;
    scheduleDismiss(toastId, durationMs);
    return clearTimer;
  }, [clearTimer, durationMs, scheduleDismiss, toastId]);

  const handleSidebarLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onBottomCoverageChange?.(event.nativeEvent.layout.height + SIDEBAR_TOAST_INSET);
    },
    [onBottomCoverageChange],
  );

  const panelClearance = useFloatingHeaderOverlayClearance();
  const headerHeight = isMobile ? HEADER_INNER_HEIGHT_MOBILE : HEADER_INNER_HEIGHT;
  const headerTopPadding = isMobile ? HEADER_TOP_PADDING_MOBILE : 0;
  const topOffset =
    placement === "app-shell" ? insets.top + headerTopPadding + headerHeight : panelClearance;

  // Keep the bottom anchor and its contents together while the native exit retains the view.
  const content = toast ? (
    <Animated.View
      entering={toastEntering}
      exiting={toastExiting}
      style={
        placement === "sidebar"
          ? animatedStyles.sidebarContainer
          : [
              animatedStyles.container,
              { top: topOffset + (placement === "app-shell" ? SPACING[2] : SPACING[3]) },
            ]
      }
      pointerEvents="box-none"
      collapsable={false}
      onLayout={placement === "sidebar" ? handleSidebarLayout : undefined}
    >
      <View
        style={placement === "sidebar" ? styles.sidebarWidthBoundary : styles.widthBoundary}
        pointerEvents="box-none"
        collapsable={false}
      >
        <View
          style={animatedStyles.surface}
          testID={toast.testID ?? "app-toast"}
          accessibilityRole="alert"
        >
          <ToastCard toast={toast} onPointerEnter={pauseDismiss} onPointerLeave={resumeDismiss} />
        </View>
      </View>
    </Animated.View>
  ) : null;

  if (placement === "app-shell" && isWeb && typeof document !== "undefined") {
    return createPortal(content, getOverlayRoot());
  }

  return placement === "panel" ? <FloatingHeaderOverlay>{content}</FloatingHeaderOverlay> : content;
}

function ToastCard({
  toast,
  onPointerEnter,
  onPointerLeave,
}: {
  toast: ToastState;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  let defaultIcon: ReactNode = null;
  if (toast.variant === "info") {
    defaultIcon = <ThemedInfo size={18} uniProps={infoIcon} />;
  } else if (toast.variant === "success") {
    defaultIcon = <ThemedCheckCircle size={18} uniProps={successIcon} />;
  } else if (toast.variant === "warning") {
    defaultIcon = <ThemedWarning size={18} uniProps={warningIcon} />;
  } else if (toast.variant === "error") {
    defaultIcon = <ThemedWarning size={18} uniProps={errorIcon} />;
  }
  const icon = toast.icon ?? defaultIcon;

  return (
    <View
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={[
        styles.toast,
        toast.variant === "info" ? styles.toastInfo : null,
        toast.variant === "warning" ? styles.toastWarning : null,
        toast.variant === "error" ? styles.toastError : null,
      ]}
    >
      {icon ? <View style={styles.iconSlot}>{icon}</View> : null}
      {typeof toast.content === "string" ? (
        <Text testID="app-toast-message" style={styles.message}>
          {toast.content}
        </Text>
      ) : (
        <View testID="app-toast-message" style={styles.contentSlot}>
          {toast.content}
        </View>
      )}
    </View>
  );
}

const animatedStyles = NativeStyleSheet.create({
  container: {
    position: "absolute",
    left: SPACING[4],
    right: SPACING[4],
    zIndex: OVERLAY_Z.toast,
    alignItems: "center",
  },
  sidebarContainer: {
    position: "absolute",
    left: SIDEBAR_TOAST_INSET,
    right: SIDEBAR_TOAST_INSET,
    bottom: SIDEBAR_TOAST_INSET,
    zIndex: OVERLAY_Z.toast,
    alignItems: "center",
  },
  surface: { alignSelf: "center", maxWidth: "100%" },
});

const styles = StyleSheet.create((theme) => ({
  widthBoundary: {
    width: "92%",
    maxWidth: TOAST_MAX_WIDTH,
    alignItems: "center",
  },
  sidebarWidthBoundary: {
    width: "100%",
    alignItems: "center",
  },
  toast: {
    alignSelf: "center",
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius["2xl"],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    ...theme.shadow.md,
  },
  toastInfo: {
    borderColor: theme.colors.palette.blue[300],
  },
  toastWarning: {
    borderColor: theme.colors.palette.amber[500],
  },
  toastError: {
    borderColor: theme.colors.destructive,
  },
  iconSlot: {
    alignItems: "center",
    justifyContent: "center",
  },
  contentSlot: {
    flexShrink: 1,
    minWidth: 0,
  },
  message: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
}));
