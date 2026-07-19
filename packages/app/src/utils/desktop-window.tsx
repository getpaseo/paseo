import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { View, type ViewProps } from "react-native";
import {
  DESKTOP_TRAFFIC_LIGHT_HEIGHT,
  DESKTOP_TRAFFIC_LIGHT_WIDTH,
  DESKTOP_WINDOW_CONTROLS_HEIGHT,
  DESKTOP_WINDOW_CONTROLS_WIDTH,
  getIsElectronRuntime,
  getIsElectronRuntimeMac,
} from "@/constants/layout";
import { getDesktopWindow } from "@/desktop/electron/window";
import { isNative } from "@/constants/platform";

export type WindowChromeCorners = "none" | "top-left" | "top-right" | "both";
type WindowChromeSafeAreaPlacement = "inline" | "below";

interface WindowChromeCornerObstruction {
  width: number;
  height: number;
}

interface WindowChromeObstruction {
  topLeft: WindowChromeCornerObstruction | null;
  topRight: WindowChromeCornerObstruction | null;
}

export type WindowChromeCorner = "top-left" | "top-right";

type WindowChromeSafeAreaStyle = { height: number } | { paddingLeft: number; paddingRight: number };

const EMPTY_OBSTRUCTION: WindowChromeObstruction = { topLeft: null, topRight: null };
const WindowChromeContext = createContext<WindowChromeObstruction>(EMPTY_OBSTRUCTION);
const WindowChromeCornersContext = createContext<WindowChromeCorners>("none");

function windowChromeCornersFromFlags(topLeft: boolean, topRight: boolean): WindowChromeCorners {
  if (topLeft && topRight) return "both";
  if (topLeft) return "top-left";
  if (topRight) return "top-right";
  return "none";
}

export function windowChromeCornersInclude(
  corners: WindowChromeCorners,
  corner: WindowChromeCorner,
): boolean {
  return corners === "both" || corners === corner;
}

export function resolveHasOwnedWindowChromeObstruction(input: {
  obstruction: WindowChromeObstruction;
  corners: WindowChromeCorners;
  corner: WindowChromeCorner;
}): boolean {
  if (!windowChromeCornersInclude(input.corners, input.corner)) return false;
  return input.corner === "top-left"
    ? input.obstruction.topLeft !== null
    : input.obstruction.topRight !== null;
}

export function useHasWindowChromeObstruction(corner: WindowChromeCorner): boolean {
  const obstruction = useContext(WindowChromeContext);
  return corner === "top-left" ? obstruction.topLeft !== null : obstruction.topRight !== null;
}

export function intersectWindowChromeCorners(
  inherited: WindowChromeCorners,
  declared: WindowChromeCorners,
): WindowChromeCorners {
  const inheritedTopLeft = inherited === "top-left" || inherited === "both";
  const inheritedTopRight = inherited === "top-right" || inherited === "both";
  const declaredTopLeft = declared === "top-left" || declared === "both";
  const declaredTopRight = declared === "top-right" || declared === "both";
  return windowChromeCornersFromFlags(
    inheritedTopLeft && declaredTopLeft,
    inheritedTopRight && declaredTopRight,
  );
}

export function resolveWindowChromeObstruction(input: {
  isElectron: boolean;
  isMac: boolean;
  isFullscreen: boolean;
}): WindowChromeObstruction {
  if (!input.isElectron || input.isFullscreen) return EMPTY_OBSTRUCTION;
  if (input.isMac) {
    return {
      topLeft: { width: DESKTOP_TRAFFIC_LIGHT_WIDTH, height: DESKTOP_TRAFFIC_LIGHT_HEIGHT },
      topRight: null,
    };
  }
  return {
    topLeft: null,
    topRight: { width: DESKTOP_WINDOW_CONTROLS_WIDTH, height: DESKTOP_WINDOW_CONTROLS_HEIGHT },
  };
}

export function resolveWindowChromeSafeArea(input: {
  obstruction: WindowChromeObstruction;
  corners: WindowChromeCorners;
  placement: WindowChromeSafeAreaPlacement;
}): WindowChromeSafeAreaStyle {
  const ownsTopLeft = input.corners === "top-left" || input.corners === "both";
  const ownsTopRight = input.corners === "top-right" || input.corners === "both";
  const topLeft = ownsTopLeft ? input.obstruction.topLeft : null;
  const topRight = ownsTopRight ? input.obstruction.topRight : null;
  if (input.placement === "below") {
    return { height: Math.max(topLeft?.height ?? 0, topRight?.height ?? 0) };
  }
  return { paddingLeft: topLeft?.width ?? 0, paddingRight: topRight?.width ?? 0 };
}

export function WindowChromeProvider({ children }: { children: ReactNode }) {
  const [isElectronReady, setIsElectronReady] = useState(getIsElectronRuntime);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    let active = true;
    let dispose: (() => void) | undefined;
    let connecting = false;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function scheduleRetry(warnOnExhaustion = false) {
      if (!active || dispose || retryTimer) return;
      if (retryCount >= 40) {
        if (warnOnExhaustion) {
          console.warn("[DesktopWindow] Chrome bridge unavailable; window controls may overlap UI");
        }
        return;
      }
      retryCount += 1;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        connect();
      }, 250);
    }

    function connect() {
      if (!active || dispose || connecting) return;
      if (!getIsElectronRuntime()) return scheduleRetry();
      const desktopWindow = getDesktopWindow();
      if (
        !desktopWindow ||
        typeof desktopWindow.isFullscreen !== "function" ||
        typeof desktopWindow.onResized !== "function"
      )
        return scheduleRetry(true);
      const readFullscreen = desktopWindow.isFullscreen;
      const subscribeToResized = desktopWindow.onResized;
      connecting = true;
      void (async () => {
        async function syncFullscreen() {
          try {
            const fullscreen = await readFullscreen();
            if (active) setIsFullscreen(fullscreen);
          } catch (error) {
            if (active) console.warn("[DesktopWindow] Failed to read fullscreen state", error);
          }
        }
        try {
          const nextDispose = await subscribeToResized(syncFullscreen);
          if (!active) return nextDispose();
          dispose = nextDispose;
          setIsElectronReady(true);
          await syncFullscreen();
        } catch (error) {
          if (active) console.warn("[DesktopWindow] Failed to subscribe to resize", error);
        } finally {
          connecting = false;
          if (!dispose) scheduleRetry();
        }
      })();
    }

    if (!isNative) connect();

    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      dispose?.();
    };
  }, []);

  const obstruction = useMemo(
    () =>
      resolveWindowChromeObstruction({
        isElectron: isElectronReady,
        isMac: getIsElectronRuntimeMac(),
        isFullscreen,
      }),
    [isElectronReady, isFullscreen],
  );
  return (
    <WindowChromeContext.Provider value={obstruction}>
      <WindowChromeCornersContext.Provider value="both">
        {children}
      </WindowChromeCornersContext.Provider>
    </WindowChromeContext.Provider>
  );
}

/** Narrows inherited corner ownership to the corners occupied by this child surface. */
export function WindowChromeRegion({
  corners,
  children,
}: {
  corners: WindowChromeCorners;
  children: ReactNode;
}) {
  const inheritedCorners = useContext(WindowChromeCornersContext);
  const ownedCorners = intersectWindowChromeCorners(inheritedCorners, corners);
  return (
    <WindowChromeCornersContext.Provider value={ownedCorners}>
      {children}
    </WindowChromeCornersContext.Provider>
  );
}

/** Restarts ownership for a new physical viewport such as a Modal or full-window overlay. */
export function WindowChromeRootRegion({
  corners,
  children,
}: {
  corners: WindowChromeCorners;
  children: ReactNode;
}) {
  return (
    <WindowChromeCornersContext.Provider value={corners}>
      {children}
    </WindowChromeCornersContext.Provider>
  );
}

export function useWindowChromeCorners(): WindowChromeCorners {
  return useContext(WindowChromeCornersContext);
}

export function useOwnsWindowChromeCorner(corner: WindowChromeCorner): boolean {
  const corners = useContext(WindowChromeCornersContext);
  return windowChromeCornersInclude(corners, corner);
}

export function useHasOwnedWindowChromeObstruction(corner: WindowChromeCorner): boolean {
  const obstruction = useContext(WindowChromeContext);
  const corners = useContext(WindowChromeCornersContext);
  return resolveHasOwnedWindowChromeObstruction({ obstruction, corners, corner });
}

type WindowChromeSafeAreaProps = ViewProps & {
  placement: WindowChromeSafeAreaPlacement;
  horizontalPadding?: number;
};

export function WindowChromeSafeArea({
  placement,
  horizontalPadding = 0,
  style,
  ...props
}: WindowChromeSafeAreaProps) {
  const obstruction = useContext(WindowChromeContext);
  const corners = useContext(WindowChromeCornersContext);
  const safeAreaStyle = useMemo(() => {
    const resolved = resolveWindowChromeSafeArea({ obstruction, corners, placement });
    if (placement === "below") return resolved;
    const paddingLeft = "paddingLeft" in resolved ? resolved.paddingLeft : 0;
    const paddingRight = "paddingRight" in resolved ? resolved.paddingRight : 0;
    return {
      paddingLeft: paddingLeft + horizontalPadding,
      paddingRight: paddingRight + horizontalPadding,
    };
  }, [corners, horizontalPadding, obstruction, placement]);
  const combinedStyle = useMemo(() => [style, safeAreaStyle], [safeAreaStyle, style]);
  return <View {...props} style={combinedStyle} />;
}
