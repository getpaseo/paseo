import { useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
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

type RawWindowControlsPadding = {
  left: number;
  right: number;
  top: number;
};

type WindowControlsPaddingRole = "sidebar" | "header" | "tabRow" | "explorerSidebar";

function useRawWindowControlsPadding(): RawWindowControlsPadding {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (Platform.OS !== "web" || !getIsElectronRuntime()) return;

    let disposed = false;
    let cleanup: (() => void) | undefined;
    let didCleanup = false;

    function runCleanup() {
      if (!cleanup || didCleanup) return;
      didCleanup = true;
      try {
        void Promise.resolve(cleanup()).catch((error) => {
          console.warn("[DesktopWindow] Failed to remove resize listener", error);
        });
      } catch (error) {
        console.warn("[DesktopWindow] Failed to remove resize listener", error);
      }
    }

    async function setup() {
      const win = getDesktopWindow();
      if (!win) return;

      const fullscreen = typeof win.isFullscreen === "function" ? await win.isFullscreen() : false;
      if (disposed) return;
      setIsFullscreen(fullscreen);

      if (typeof win.onResized !== "function") {
        return;
      }

      const unlisten = await win.onResized(async () => {
        if (disposed) return;
        const fs = typeof win.isFullscreen === "function" ? await win.isFullscreen() : false;
        if (disposed) return;
        setIsFullscreen(fs);
      });

      cleanup = unlisten;
      if (disposed) {
        runCleanup();
      }
    }

    void setup();

    return () => {
      disposed = true;
      runCleanup();
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

export function useWindowControlsPadding(
  role: WindowControlsPaddingRole,
): { left: number; right: number; top: number } {
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
