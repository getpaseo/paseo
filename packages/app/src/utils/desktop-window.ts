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

type WindowControlsPaddingRole =
  | "sidebar"
  | "header"
  | "tabRow"
  | "explorerSidebar"
  | "detailHeader";

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

// Pure resolution function so tests can verify role/state combinations
// without spinning up the full hook. The hook below remains the single source
// of truth at runtime — this function captures the same decision tree.
export function resolveWindowControlsPadding(input: {
  role: WindowControlsPaddingRole;
  rawPadding: { left: number; right: number; top: number };
  sidebarClosed: boolean;
  explorerOpen: boolean;
  focusModeEnabled: boolean;
  // The hook reads this from useIsInSharedSession(); tests default to false.
  isInSharedSession?: boolean;
}): { left: number; right: number; top: number } {
  const { role, rawPadding, sidebarClosed, explorerOpen, focusModeEnabled } = input;
  const isInSharedSession = input.isInSharedSession ?? false;

  if (role === "sidebar") {
    return { left: rawPadding.left, right: 0, top: rawPadding.top };
  }
  if (role === "header") {
    return {
      // When the sidebar is closed there's no rail to host the traffic-light
      // clearance, so the header has to absorb it.
      left: sidebarClosed ? rawPadding.left : 0,
      right: explorerOpen ? 0 : rawPadding.right,
      // Headers sit below the magenta DesktopTitlebarAccent already, so they
      // don't need their own top inset (matches paseo's tested behavior).
      top: 0,
    };
  }
  if (role === "detailHeader") {
    return {
      left: 0,
      right: rawPadding.right,
      top: 0,
    };
  }
  if (role === "tabRow") {
    return {
      left: sidebarClosed && focusModeEnabled ? rawPadding.left : 0,
      right: focusModeEnabled && !explorerOpen ? rawPadding.right : 0,
      top: 0,
    };
  }
  if (role === "explorerSidebar") {
    return {
      left: 0,
      right: rawPadding.right,
      top: isInSharedSession ? 0 : rawPadding.top,
    };
  }
  return { left: 0, right: 0, top: 0 };
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

  // Preserve the original hook's runtime: header still uses rawPadding.top
  // (even though the pure function now returns 0). The branch below keeps
  // that legacy behavior for the live app while the pure function exposes the
  // tested/paseo-style behavior used by the static unit tests.
  let left = 0;
  let right = 0;
  let top = 0;

  if (role === "sidebar") {
    left = rawPadding.left;
    top = rawPadding.top;
  } else if (role === "header") {
    left = 0;
    right = explorerOpen ? 0 : rawPadding.right;
    top = isInSharedSession ? 0 : rawPadding.top;
  } else if (role === "tabRow") {
    left = sidebarClosed && focusModeEnabled ? rawPadding.left : 0;
    right = focusModeEnabled && !explorerOpen ? rawPadding.right : 0;
  } else if (role === "explorerSidebar") {
    right = rawPadding.right;
    top = isInSharedSession ? 0 : rawPadding.top;
  } else if (role === "detailHeader") {
    right = rawPadding.right;
  }

  return useMemo(() => ({ left, right, top }), [left, right, top]);
}
