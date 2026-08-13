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
import { isNative, isWeb } from "@/constants/platform";

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

/**
 * The titlebar strip Chromium leaves to the app, and the window it sits in.
 *
 * Whatever the window manager kept for its own controls is the difference between the two —
 * on either side, because a Linux desktop may put them left, right, or both.
 */
export interface WindowControlsOverlayGeometry {
  titlebarLeft: number;
  titlebarWidth: number;
  titlebarHeight: number;
  windowWidth: number;
}

/**
 * Where the native controls physically sit, measured when the platform will tell us.
 *
 * The fallback constants describe Windows: three buttons on the right. They are only a
 * starting point — a Linux desktop environment chooses its own side and button count, and
 * even Windows varies the cluster width with text scaling. Prefer the measured rectangle and
 * treat the constants as what to use until it arrives.
 */
export function resolveWindowChromeObstruction(input: {
  isElectron: boolean;
  isMac: boolean;
  isFullscreen: boolean;
  overlay?: WindowControlsOverlayGeometry | null;
}): WindowChromeObstruction {
  if (!input.isElectron || input.isFullscreen) return EMPTY_OBSTRUCTION;
  if (input.isMac) {
    return {
      topLeft: { width: DESKTOP_TRAFFIC_LIGHT_WIDTH, height: DESKTOP_TRAFFIC_LIGHT_HEIGHT },
      topRight: null,
    };
  }

  const measured = resolveMeasuredWindowChromeObstruction(input.overlay);
  if (measured) return measured;

  return {
    topLeft: null,
    topRight: { width: DESKTOP_WINDOW_CONTROLS_WIDTH, height: DESKTOP_WINDOW_CONTROLS_HEIGHT },
  };
}

function resolveMeasuredWindowChromeObstruction(
  overlay: WindowControlsOverlayGeometry | null | undefined,
): WindowChromeObstruction | null {
  if (!overlay) return null;
  const { titlebarLeft, titlebarWidth, titlebarHeight, windowWidth } = overlay;
  // A zero-width strip means the overlay is not laid out yet, and a strip wider than its window
  // means we are reading it mid-resize. Neither is a measurement worth trusting.
  if (!(titlebarWidth > 0) || !(windowWidth > 0)) return null;
  if (titlebarLeft < 0 || titlebarLeft + titlebarWidth > windowWidth) return null;

  const height = titlebarHeight > 0 ? titlebarHeight : DESKTOP_WINDOW_CONTROLS_HEIGHT;
  const leftWidth = titlebarLeft;
  const rightWidth = windowWidth - (titlebarLeft + titlebarWidth);
  // The overlay covers the whole width when the controls are drawn outside it entirely; there is
  // nothing to clear, so let the caller fall back rather than report an unobstructed titlebar.
  if (leftWidth <= 0 && rightWidth <= 0) return null;

  return {
    topLeft: leftWidth > 0 ? { width: leftWidth, height } : null,
    topRight: rightWidth > 0 ? { width: rightWidth, height } : null,
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

interface WindowControlsOverlayApi {
  visible: boolean;
  getTitlebarAreaRect: () => { x: number; width: number; height: number };
  addEventListener: (type: "geometrychange", listener: () => void) => void;
  removeEventListener: (type: "geometrychange", listener: () => void) => void;
}

function getWindowControlsOverlayApi(): WindowControlsOverlayApi | null {
  if (!isWeb) return null;
  const api = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayApi })
    .windowControlsOverlay;
  return api && typeof api.getTitlebarAreaRect === "function" ? api : null;
}

/**
 * Follows the real titlebar rectangle so the app clears whatever controls the platform drew.
 *
 * Chromium fires geometrychange when the window is maximized, restored, or the controls change
 * shape, which is also how a Linux desktop environment's own placement reaches us. Returns null
 * where the API is missing, leaving the caller on its Windows-shaped fallback.
 */
function useWindowControlsOverlayGeometry(): WindowControlsOverlayGeometry | null {
  const [geometry, setGeometry] = useState<WindowControlsOverlayGeometry | null>(null);

  useEffect(() => {
    const api = getWindowControlsOverlayApi();
    if (!api) return;
    let frame: number | null = null;

    function read() {
      const rect = api?.getTitlebarAreaRect();
      if (!rect) return;
      setGeometry((current) => {
        const next: WindowControlsOverlayGeometry = {
          titlebarLeft: rect.x,
          titlebarWidth: rect.width,
          titlebarHeight: rect.height,
          windowWidth: window.innerWidth,
        };
        if (
          current &&
          current.titlebarLeft === next.titlebarLeft &&
          current.titlebarWidth === next.titlebarWidth &&
          current.titlebarHeight === next.titlebarHeight &&
          current.windowWidth === next.windowWidth
        ) {
          return current;
        }
        return next;
      });
    }

    // A drag-resize fires geometrychange and resize together, and Chromium fires geometrychange
    // more than once per resize as intermediate layout passes report intermediate rectangles.
    // The rectangle itself is a cached read, but window.innerWidth below is not, and each
    // distinct result re-renders every header row. One read per frame is enough.
    function schedule() {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        read();
      });
    }

    read();
    api.addEventListener("geometrychange", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      api.removeEventListener("geometrychange", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return geometry;
}

export function WindowChromeProvider({ children }: { children: ReactNode }) {
  const [isElectronReady, setIsElectronReady] = useState(getIsElectronRuntime);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const overlay = useWindowControlsOverlayGeometry();

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
        overlay,
      }),
    [isElectronReady, isFullscreen, overlay],
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
