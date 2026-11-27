import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
} from "react";
import { StyleSheet, View } from "react-native";
import { PortalHost } from "@gorhom/portal";
import {
  createFloatingPanelHosts,
  type FloatingPanelHostRect,
} from "@/components/ui/floating-panel-hosts";

export const DEFAULT_FLOATING_PANEL_PORTAL_HOST = "content-floating-panels";

const FloatingPanelPortalHostNameContext = createContext(DEFAULT_FLOATING_PANEL_PORTAL_HOST);

const portalHosts = createFloatingPanelHosts<View>();

export function measureFloatingPanelPortalHost(
  name: string,
): Promise<FloatingPanelHostRect | null> {
  return portalHosts.measure(name);
}

export function FloatingPanelPortalHostNameProvider({
  hostName,
  children,
}: {
  hostName: string;
  children: ReactNode;
}): ReactElement {
  return (
    <FloatingPanelPortalHostNameContext.Provider value={hostName}>
      {children}
    </FloatingPanelPortalHostNameContext.Provider>
  );
}

export function useFloatingPanelPortalHostName(): string {
  return useContext(FloatingPanelPortalHostNameContext);
}

export function FloatingPanelPortalHost({
  name = DEFAULT_FLOATING_PANEL_PORTAL_HOST,
}: {
  name?: string;
}): ReactElement {
  const hostRef = useRef<View>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    return portalHosts.register(name, host);
  }, [name]);

  return (
    <View ref={hostRef} collapsable={false} pointerEvents="box-none" style={styles.host}>
      <PortalHost name={name} />
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    ...StyleSheet.absoluteFill,
  },
});
