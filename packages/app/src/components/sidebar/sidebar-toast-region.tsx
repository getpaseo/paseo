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
import { View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import {
  TOAST_FADE_MS,
  ToastViewport,
  useToastHost,
  type ToastApi,
  type ToastState,
} from "@/components/toast-host";
import { ToastApiProvider, useToast } from "@/contexts/toast-context";

interface SidebarToastCoverage {
  toastVisible: boolean;
  /** Distance from the region's bottom edge to the toast's top edge, as last laid out. */
  height: SharedValue<number>;
}

const SidebarToastCoverageContext = createContext<SidebarToastCoverage | null>(null);
const SidebarPersistentToastContext = createContext<((toast: ToastState | null) => void) | null>(
  null,
);
const SidebarAppToastContext = createContext<ToastApi | null>(null);

/**
 * Shows toasts raised by the sidebar's list over its bottom edge, just above the footer.
 *
 * A collapsed sidebar stays mounted and its rows still handle shortcuts, so while it is hidden
 * their toasts go to the app's host instead. The sidebar's API stays stable across open and close
 * so that toggling the panel doesn't re-render every row.
 */
export function SidebarToastRegion({ active, children }: { active: boolean; children: ReactNode }) {
  const appToast = useToast();
  const { api: sidebarToast, toast, dismiss } = useToastHost();
  const [persistentToast, setPersistentToast] = useState<ToastState | null>(null);
  const activeRef = useRef(active);
  const coverageHeight = useSharedValue(0);
  const toastVisible = toast !== null || persistentToast !== null;

  useEffect(() => {
    activeRef.current = active;
    return () => {
      // An archive holds on to this API, so a failure that lands later needs a host on screen.
      activeRef.current = false;
      // A toast must not outlive its visibility: its dismissal is what ends an archive's undo.
      dismiss();
    };
  }, [active, dismiss]);

  const api = useMemo<ToastApi>(() => {
    const visibleHost = () => (activeRef.current ? sidebarToast : appToast);
    return {
      show: (content, options) => visibleHost().show(content, options),
      copied: (label) => visibleHost().copied(label),
      error: (message) => visibleHost().error(message),
    };
  }, [appToast, sidebarToast]);

  const coverage = useMemo<SidebarToastCoverage>(
    () => ({ toastVisible, height: coverageHeight }),
    [toastVisible, coverageHeight],
  );
  const handleCoverageChange = useCallback(
    (height: number) => {
      coverageHeight.value = height;
    },
    [coverageHeight],
  );

  return (
    <View style={styles.region}>
      <ToastApiProvider api={api}>
        <SidebarAppToastContext.Provider value={appToast}>
          <SidebarPersistentToastContext.Provider value={setPersistentToast}>
            <SidebarToastCoverageContext.Provider value={coverage}>
              {children}
            </SidebarToastCoverageContext.Provider>
          </SidebarPersistentToastContext.Provider>
        </SidebarAppToastContext.Provider>
        <ToastViewport
          toast={toast}
          persistentToast={persistentToast}
          onDismiss={dismiss}
          placement="sidebar"
          onBottomCoverageChange={handleCoverageChange}
        />
      </ToastApiProvider>
    </View>
  );
}

/** Returns the enclosing app-level toast API so sidebar callers can report errors without displacing an active sidebar undo toast. */
export function useSidebarAppToast(): ToastApi {
  const fallbackToast = useToast();
  return useContext(SidebarAppToastContext) ?? fallbackToast;
}

/**
 * Displays a persistent toast in the enclosing `SidebarToastRegion`, stacked below any active
 * transient toast so controls stay reachable while a previous toast is up.
 */
export function useSidebarPersistentToast(toast: ToastState | null): void {
  const setPersistentToast = useContext(SidebarPersistentToastContext);
  useEffect(() => {
    setPersistentToast?.(toast);
  }, [setPersistentToast, toast]);
  useEffect(() => {
    return () => {
      setPersistentToast?.(null);
    };
  }, [setPersistentToast]);
}

/**
 * Space at the end of a sidebar list that matches the toast covering it, so the last row can
 * scroll clear of the toast. It sits below every row, so growing it moves nothing. It shrinks
 * with the toast's fade, so a list scrolled to its end settles back with the toast instead of
 * jumping.
 */
export function SidebarToastClearance() {
  const coverage = useContext(SidebarToastCoverageContext);
  return coverage ? <AnimatedClearance coverage={coverage} /> : null;
}

function AnimatedClearance({ coverage }: { coverage: SidebarToastCoverage }) {
  const { toastVisible, height } = coverage;
  const style = useAnimatedStyle(() => ({
    height: withTiming(toastVisible ? height.value : 0, { duration: TOAST_FADE_MS }),
  }));
  return (
    <Animated.View
      style={style}
      pointerEvents="none"
      testID="sidebar-toast-clearance"
      aria-hidden
    />
  );
}

const styles = StyleSheet.create({
  region: {
    position: "relative",
    flex: 1,
    minHeight: 0,
  },
});
