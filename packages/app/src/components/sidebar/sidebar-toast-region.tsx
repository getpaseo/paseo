import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ToastViewport, useToastHost, type ToastApi } from "@/components/toast-host";
import { ToastApiProvider, useToast } from "@/contexts/toast-context";

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
  const activeRef = useRef(active);

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

  return (
    <View style={styles.region}>
      <ToastApiProvider api={api}>{children}</ToastApiProvider>
      <ToastViewport toast={toast} onDismiss={dismiss} placement="sidebar" />
    </View>
  );
}

const styles = StyleSheet.create({
  region: {
    position: "relative",
    flex: 1,
    minHeight: 0,
  },
});
