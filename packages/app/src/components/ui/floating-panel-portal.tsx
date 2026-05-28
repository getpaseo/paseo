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

export const DEFAULT_FLOATING_PANEL_PORTAL_HOST = "content-floating-panels";

const FloatingPanelPortalHostNameContext = createContext(DEFAULT_FLOATING_PANEL_PORTAL_HOST);

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const portalHostElements = new Map<string, View>();

function measureElement(element: View): Promise<Rect> {
  return new Promise((resolve) => {
    element.measureInWindow((x, y, width, height) => {
      resolve({ x, y, width, height });
    });
  });
}

export function measureFloatingPanelPortalHost(name: string): Promise<Rect | null> {
  const element = portalHostElements.get(name);
  if (!element) return Promise.resolve(null);
  return measureElement(element);
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
    portalHostElements.set(name, host);
    return () => {
      if (portalHostElements.get(name) === host) {
        portalHostElements.delete(name);
      }
    };
  }, [name]);

  return (
    <View ref={hostRef} collapsable={false} pointerEvents="box-none" style={styles.host}>
      <PortalHost name={name} />
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    ...StyleSheet.absoluteFillObject,
  },
});
