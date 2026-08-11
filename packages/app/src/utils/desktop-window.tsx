import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { View, type ViewProps } from "react-native";
import {
  DESKTOP_TRAFFIC_LIGHT_HEIGHT,
  DESKTOP_TRAFFIC_LIGHT_WIDTH,
  DESKTOP_WINDOW_CONTROLS_INLINE_SPARE_WIDTH_HIGH,
  DESKTOP_WINDOW_CONTROLS_INLINE_SPARE_WIDTH_LOW,
  DESKTOP_WINDOW_CONTROLS_HEIGHT,
  DESKTOP_WINDOW_CONTROLS_WIDTH,
  getIsElectronRuntime,
  getIsElectronRuntimeMac,
} from "@/constants/layout";
import { getDesktopWindow } from "@/desktop/electron/window";
import { isNative } from "@/constants/platform";

export type WindowChromeCorners = "none" | "top-left" | "top-right" | "both";
export type WindowChromeSafeAreaPlacement = "inline" | "below";

export interface WindowChromeRowMeasurement {
  availableWidth: number | null;
  contentWidth: number | null;
  previousPlacement: WindowChromeSafeAreaPlacement;
}

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

export function useHasWindowChromeObstruction(corner: WindowChromeCorner): boolean {
  const obstruction = useContext(WindowChromeContext);
  return corner === "top-left" ? obstruction.topLeft !== null : obstruction.topRight !== null;
}

export function useWindowChromeRowPlacement(
  measurement: WindowChromeRowMeasurement,
): WindowChromeSafeAreaPlacement {
  const obstruction = useContext(WindowChromeContext);
  return resolveWindowChromeRowPlacement({ obstruction, ...measurement });
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

/**
 * Where a header row sits relative to the native window controls.
 *
 * macOS keeps the row inline: the traffic lights sit in the top-left, ahead of the row's
 * leading content, and padding past them costs nothing.
 *
 * Windows/Linux controls sit in the top-right, on top of the row's trailing actions. Pad past
 * them while the row can spare the width — a wide row has empty middle to give away, and a
 * reserved strip would waste 29px of height for nothing. Once the content no longer fits in
 * what is left, padding would clip the trailing actions instead of moving them, so the row
 * reserves the controls' height in a strip and starts below them.
 *
 * The two spare-width margins differ on purpose: a row already inline holds its place down to
 * the smaller one, and a dropped row needs the larger one before it climbs back. Without that
 * gap, dragging a splitter across a single threshold flips the row every frame.
 *
 * Read from the obstruction rather than the platform, so it stays correct while the Electron
 * bridge is still resolving. Only top-right controls move the row: browser, native, and
 * fullscreen have no obstruction at all and keep the inline row they always had.
 *
 * A row starts inline and only drops once a measurement proves it does not fit. Defaulting an
 * unmeasured row to the strip would push every header down on load — including the wide ones
 * that never needed it — and then yank them up a frame later when the measurement arrives.
 */
export function resolveWindowChromeRowPlacement(
  input: { obstruction: WindowChromeObstruction } & WindowChromeRowMeasurement,
): WindowChromeSafeAreaPlacement {
  const { obstruction, availableWidth, contentWidth, previousPlacement } = input;
  const topRight = obstruction.topRight;
  if (topRight === null) return "inline";
  if (availableWidth === null || contentWidth === null) return "inline";

  const spareWidth = availableWidth - contentWidth - topRight.width;
  if (previousPlacement === "inline") {
    return spareWidth < DESKTOP_WINDOW_CONTROLS_INLINE_SPARE_WIDTH_LOW ? "below" : "inline";
  }
  return spareWidth > DESKTOP_WINDOW_CONTROLS_INLINE_SPARE_WIDTH_HIGH ? "inline" : "below";
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

/**
 * What colour the native window controls should be painted, or null to leave them alone.
 *
 * The controls are drawn by the OS over whatever surface reaches the top-right corner, so they
 * only look native while they match it: the explorer's sidebar surface while it is open, the
 * content surface otherwise. macOS draws its own traffic lights and takes no colour from us,
 * and outside Electron there are no controls to paint.
 */
export function resolveWindowControlsBackground(input: {
  isElectron: boolean;
  isMac: boolean;
  isExplorerOpen: boolean;
  sidebarColor: string;
  contentColor: string;
}): string | null {
  if (!input.isElectron || input.isMac) return null;
  return input.isExplorerOpen ? input.sidebarColor : input.contentColor;
}

type WindowChromeSafeAreaProps = ViewProps & {
  placement: WindowChromeSafeAreaPlacement;
  horizontalPadding?: number;
  /** Forwarded to the underlying View so a caller can measure the row it renders. */
  viewRef?: Ref<View>;
};

export function WindowChromeSafeArea({
  placement,
  horizontalPadding = 0,
  style,
  viewRef,
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
  return <View {...props} ref={viewRef} style={combinedStyle} />;
}
