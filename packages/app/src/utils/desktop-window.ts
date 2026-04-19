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
import { useIsInSharedSession } from "@/stores/shared-session-store";
import { isNative } from "@/constants/platform";

type RawWindowControlsPadding = {
  left: number;
  right: number;
  top: number;
};

type WindowControlsPaddingRole = "sidebar" | "header" | "tabRow" | "explorerSidebar";

function useRawWindowControlsPadding(): RawWindowControlsPadding {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (isNative || !getIsElectronRuntime()) return;

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

export function useWindowControlsPadding(role: WindowControlsPaddingRole): {
  left: number;
  right: number;
  top: number;
} {
  const sidebarOpen = usePanelStore((state) => state.desktop.agentListOpen);
  const explorerOpen = usePanelStore((state) => state.desktop.fileExplorerOpen);
  const focusModeEnabled = usePanelStore((state) => state.desktop.focusModeEnabled);
  const isInSharedSession = useIsInSharedSession();
  const rawPadding = useRawWindowControlsPadding();
  const sidebarClosed = !sidebarOpen;

  let left = 0;
  let right = 0;
  let top = 0;

  if (role === "sidebar") {
    left = rawPadding.left;
    top = rawPadding.top;
  } else if (role === "header") {
    // The sidebar (or its collapsed rail) always sits to the left of the
    // header, so the traffic-light clearance is handled there — don't
    // double-pad the header.
    left = 0;
    right = explorerOpen ? 0 : rawPadding.right;
    // Push the header below the magenta `DesktopTitlebarAccent` so it
    // doesn't cover the branch switcher + Open + Push controls. When a
    // shared session is active, the participant bar already sits above the
    // header and handles the traffic-light vertical clearance — adding our
    // own offset on top of that creates a visible gap.
    top = isInSharedSession ? 0 : rawPadding.top;
  } else if (role === "tabRow") {
    left = sidebarClosed && focusModeEnabled ? rawPadding.left : 0;
    right = focusModeEnabled && !explorerOpen ? rawPadding.right : 0;
  } else if (role === "explorerSidebar") {
    right = rawPadding.right;
  }

  return useMemo(() => ({ left, right, top }), [left, right, top]);
}
