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
import {
  Animated,
  Easing,
  Platform,
  Text,
  ToastAndroid,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { CheckCircle2, AlertTriangle } from "lucide-react-native";

type ToastVariant = "default" | "success" | "error";

export type ToastShowOptions = {
  variant?: ToastVariant;
  durationMs?: number;
  /**
   * On Android we prefer the OS toast by default.
   * Set to false to force the in-app toast.
   */
  nativeAndroid?: boolean;
  testID?: string;
};

type ToastState = {
  id: number;
  message: string;
  variant: ToastVariant;
  durationMs: number;
  testID?: string;
};

export type ToastApi = {
  show: (message: string, options?: ToastShowOptions) => void;
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
    (message: string, options?: ToastShowOptions) => {
      const resolvedMessage = message.trim();
      if (!resolvedMessage) return;

      const variant = options?.variant ?? "default";
      const durationMs = options?.durationMs ?? DEFAULT_DURATION_MS;
      const nativeAndroid = options?.nativeAndroid ?? true;

      if (Platform.OS === "android" && nativeAndroid) {
        const duration =
          durationMs <= 2500
            ? ToastAndroid.SHORT
            : ToastAndroid.LONG;
        ToastAndroid.showWithGravity(
          resolvedMessage,
          duration,
          ToastAndroid.BOTTOM
        );
        return;
      }

      idRef.current += 1;
      setToast({
        id: idRef.current,
        message: resolvedMessage,
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
        show(label ? `Copied ${label}` : "Copied", { variant: "success" }),
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
  const translateY = useRef(new Animated.Value(8)).current;
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
        toValue: 8,
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
      translateY.setValue(8);
      return;
    }

    clearTimer();
    opacity.setValue(0);
    translateY.setValue(8);

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

  const icon =
    toast.variant === "success" ? (
      <CheckCircle2 size={18} color={theme.colors.primary} />
    ) : toast.variant === "error" ? (
      <AlertTriangle size={18} color={theme.colors.destructive} />
    ) : null;

  return (
    <View style={styles.container} pointerEvents="box-none">
      <Animated.View
        testID={toast.testID ?? "app-toast"}
        style={[
          styles.toast,
          {
            marginBottom: theme.spacing[4] + insets.bottom,
            opacity,
            transform: [{ translateY }],
          },
        ]}
        accessibilityRole="alert"
      >
        {icon ? <View style={styles.iconSlot}>{icon}</View> : null}
        <Text
          testID="app-toast-message"
          style={[
            styles.message,
            toast.variant === "error" ? styles.messageError : null,
          ]}
          numberOfLines={2}
        >
          {toast.message}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    left: theme.spacing[4],
    right: theme.spacing[4],
    bottom: 0,
    zIndex: 1100,
    alignItems: "center",
  },
  toast: {
    width: "100%",
    maxWidth: 520,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
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
  iconSlot: {
    alignItems: "center",
    justifyContent: "center",
  },
  message: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  messageError: {
    color: theme.colors.foreground,
  },
}));
