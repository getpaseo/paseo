import { useEffect, useMemo, useState } from "react";
import {
  getIsElectronRuntimeMac,
  getIsElectronRuntime,
  DESKTOP_TRAFFIC_LIGHT_WIDTH,
  DESKTOP_TRAFFIC_LIGHT_HEIGHT,
  DESKTOP_WINDOW_CONTROLS_WIDTH,
  DESKTOP_WINDOW_CONTROLS_HEIGHT,
} from "@/constants/layout";
import { getDesktopWindow } from "@/desktop/electron/window";
import { usePanelStore } from "@/stores/panel-store";
import { isNative } from "@/constants/platform";

type RawWindowControlsPadding = {
  left: number;
  right: number;
  top: number;
};

type WindowControlsPaddingRole = "sidebar" | "header" | "tabRow" | "explorerSidebar";

// Module-level cache so hook remounts (e.g., on navigation) don't briefly
// fall back to the default `false` while the async fullscreen check resolves.
// Without this, in fullscreen the sidebar flashes with traffic-light padding
// on first frame and then snaps to 0 once the async read completes.
let cachedIsFullscreen = false;
const fullscreenSubscribers = new Set<(value: boolean) => void>();
let fullscreenSubscriptionStarted = false;

function setCachedFullscreen(value: boolean) {
  if (cachedIsFullscreen === value) return;
  cachedIsFullscreen = value;
  for (const sub of fullscreenSubscribers) {
    sub(value);
  }
}

function startFullscreenSubscription() {
  if (fullscreenSubscriptionStarted) return;
  if (isNative || !getIsElectronRuntime()) return;
  fullscreenSubscriptionStarted = true;

  void (async () => {
    const win = getDesktopWindow();
    if (!win) return;

    if (typeof win.isFullscreen === "function") {
      try {
        setCachedFullscreen(await win.isFullscreen());
      } catch (error) {
        console.warn("[DesktopWindow] Failed to read fullscreen state", error);
      }
    }

    if (typeof win.onResized !== "function") return;

    try {
      await win.onResized(async () => {
        if (typeof win.isFullscreen !== "function") return;
        try {
          setCachedFullscreen(await win.isFullscreen());
        } catch (error) {
          console.warn("[DesktopWindow] Failed to read fullscreen state", error);
        }
      });
    } catch (error) {
      console.warn("[DesktopWindow] Failed to subscribe to resize", error);
    }
  })();
}

function useRawWindowControlsPadding(): RawWindowControlsPadding {
  const [isFullscreen, setIsFullscreen] = useState(cachedIsFullscreen);

  useEffect(() => {
    startFullscreenSubscription();
    // Sync to any value that resolved between render and effect.
    setIsFullscreen(cachedIsFullscreen);
    fullscreenSubscribers.add(setIsFullscreen);
    return () => {
      fullscreenSubscribers.delete(setIsFullscreen);
    };
  }, []);

  return useMemo((): RawWindowControlsPadding => {
    if (!getIsElectronRuntime() || isFullscreen) {
      return { left: 0, right: 0, top: 0 };
    }

    if (getIsElectronRuntimeMac()) {
      return {
        left: DESKTOP_TRAFFIC_LIGHT_WIDTH,
        right: 0,
        top: DESKTOP_TRAFFIC_LIGHT_HEIGHT,
      };
    }

    return {
      left: 0,
      right: DESKTOP_WINDOW_CONTROLS_WIDTH,
      top: DESKTOP_WINDOW_CONTROLS_HEIGHT,
    };
  }, [isFullscreen]);
}

export function useWindowControlsPadding(role: WindowControlsPaddingRole): {
  left: number;
  right: number;
  top: number;
} {
  const sidebarOpen = usePanelStore((state) => state.desktop.agentListOpen);
  const explorerOpen = usePanelStore((state) => state.desktop.fileExplorerOpen);
  const focusModeEnabled = usePanelStore((state) => state.desktop.focusModeEnabled);
  const rawPadding = useRawWindowControlsPadding();
  const sidebarClosed = !sidebarOpen;

  let left = 0;
  let right = 0;
  let top = 0;

  if (role === "sidebar") {
    left = rawPadding.left;
    top = rawPadding.top;
  } else if (role === "header") {
    left = sidebarClosed ? rawPadding.left : 0;
    right = explorerOpen ? 0 : rawPadding.right;
  } else if (role === "tabRow") {
    left = sidebarClosed && focusModeEnabled ? rawPadding.left : 0;
    right = focusModeEnabled && !explorerOpen ? rawPadding.right : 0;
  } else if (role === "explorerSidebar") {
    right = rawPadding.right;
  }

  return useMemo(() => ({ left, right, top }), [left, right, top]);
}
