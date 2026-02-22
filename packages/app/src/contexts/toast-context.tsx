import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { getOverlayRoot, OVERLAY_Z } from "../lib/overlay-root";
import {
  Animated,
  Easing,
  Platform,
  Text,
  ToastAndroid,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { CheckCircle2, AlertTriangle } from "lucide-react-native";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
} from "@/constants/layout";

type ToastVariant = "default" | "success" | "error";

export type ToastShowOptions = {
  icon?: ReactNode;
  variant?: ToastVariant;
  durationMs?: number;
  /**
   * Set to true to use OS toast on Android.
   */
  nativeAndroid?: boolean;
  testID?: string;
};

type ToastState = {
  id: number;
  content: ReactNode;
  nativeMessage: string | null;
  icon?: ReactNode;
  variant: ToastVariant;
  durationMs: number;
  testID?: string;
};

export type ToastApi = {
  show: (content: ReactNode, options?: ToastShowOptions) => void;
  copied: (label?: string) => void;
  error: (message: string) => void;
};

const DEFAULT_DURATION_MS = 2200;

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return value;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const idRef = useRef(0);

  const show = useCallback(
    (content: ReactNode, options?: ToastShowOptions) => {
      const nativeMessage =
        typeof content === "string"
          ? content.trim()
          : null;
      if (!content || nativeMessage === "") return;

      const variant = options?.variant ?? "default";
      const durationMs = options?.durationMs ?? DEFAULT_DURATION_MS;
      const nativeAndroid = options?.nativeAndroid ?? false;

      if (Platform.OS === "android" && nativeAndroid && nativeMessage) {
        const duration =
          durationMs <= 2500
            ? ToastAndroid.SHORT
            : ToastAndroid.LONG;
        ToastAndroid.showWithGravity(
          nativeMessage,
          duration,
          ToastAndroid.TOP
        );
        return;
      }

      idRef.current += 1;
      setToast({
        id: idRef.current,
        content,
        nativeMessage,
        icon: options?.icon,
        variant,
        durationMs,
        testID: options?.testID,
      });
    },
    []
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      copied: (label?: string) =>
        show(label ? `Copied ${label}` : "Copied", {
          variant: "success",
          icon: <CheckCircle2 size={18} />,
        }),
      error: (message: string) => show(message, { variant: "error", durationMs: 3200 }),
    }),
    [show]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toast={toast} onDismiss={() => setToast(null)} />
    </ToastContext.Provider>
  );
}

function ToastViewport({
  toast,
  onDismiss,
}: {
  toast: ToastState | null;
  onDismiss: () => void;
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-8)).current;
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const animateOut = useCallback(() => {
    clearTimer();
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 0,
        duration: 140,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: -8,
        duration: 140,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) {
        onDismiss();
      }
    });
  }, [clearTimer, onDismiss, opacity, translateY]);

  useEffect(() => {
    if (!toast) {
      clearTimer();
      opacity.setValue(0);
      translateY.setValue(-8);
      return;
    }

    clearTimer();
    opacity.setValue(0);
    translateY.setValue(-8);

    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 140,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 140,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();

    timeoutRef.current = setTimeout(() => {
      animateOut();
    }, toast.durationMs);

    return () => {
      clearTimer();
    };
  }, [animateOut, clearTimer, opacity, toast, translateY]);

  if (!toast) {
    return null;
  }

  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const headerHeight = isMobile ? HEADER_INNER_HEIGHT_MOBILE : HEADER_INNER_HEIGHT;
  const headerTopPadding = isMobile ? HEADER_TOP_PADDING_MOBILE : 0;

  const icon =
    toast.icon ?? (
      toast.variant === "success" ? (
      <CheckCircle2 size={18} color={theme.colors.primary} />
    ) : toast.variant === "error" ? (
      <AlertTriangle size={18} color={theme.colors.destructive} />
    ) : null
    );

  const content = (
    <View style={styles.container} pointerEvents="box-none">
      <Animated.View
        testID={toast.testID ?? "app-toast"}
        style={[
          styles.toast,
          toast.variant === "success" ? styles.toastSuccess : null,
          toast.variant === "error" ? styles.toastError : null,
          {
            marginTop:
              insets.top + headerTopPadding + headerHeight + theme.spacing[2],
            opacity,
            transform: [{ translateY }],
          },
        ]}
        accessibilityRole="alert"
      >
        {icon ? <View style={styles.iconSlot}>{icon}</View> : null}
        {typeof toast.content === "string" ? (
          <Text
            testID="app-toast-message"
            style={[
              styles.message,
              toast.variant === "error" ? styles.messageError : null,
            ]}
            numberOfLines={2}
          >
            {toast.content}
          </Text>
        ) : (
          <View testID="app-toast-message" style={styles.contentSlot}>
            {toast.content}
          </View>
        )}
      </Animated.View>
    </View>
  );

  // On web, portal to overlay root to control stacking order
  if (Platform.OS === "web" && typeof document !== "undefined") {
    return createPortal(content, getOverlayRoot());
  }

  return content;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    left: theme.spacing[4],
    right: theme.spacing[4],
    top: 0,
    zIndex: OVERLAY_Z.toast,
    alignItems: "center",
  },
  toast: {
    alignSelf: "center",
    maxWidth: "92%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 8,
  },
  toastSuccess: {
    borderColor: theme.colors.border,
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
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  messageError: {
    color: theme.colors.foreground,
  },
}));
