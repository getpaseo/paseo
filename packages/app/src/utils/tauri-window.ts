import { Platform } from "react-native";
import { useState, useEffect } from "react";
import { getIsTauriMac, TAURI_TRAFFIC_LIGHT_WIDTH, TAURI_TRAFFIC_LIGHT_HEIGHT } from "@/constants/layout";

let tauriWindow: any = null;

// Runtime check for Tauri environment
function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" &&
    (window as any).__TAURI__ !== undefined;
}

async function getTauriWindow() {
  if (tauriWindow) return tauriWindow;

  // Double-check: both environment check AND platform check
  if (!isTauriEnvironment()) {
    return null;
  }

  try {
    // When `app.withGlobalTauri` is enabled, Tauri exposes its JS APIs on `window.__TAURI__`.
    // We must use that here because importing `@tauri-apps/api/*` would be bundled into
    // the native (Hermes) builds and break parsing/runtime on mobile.
    const tauri = (window as any).__TAURI__ as any;

    // Prefer the public global window module.
    const windowModule = tauri?.window;
    if (windowModule && typeof windowModule.getCurrentWindow === "function") {
      tauriWindow = windowModule.getCurrentWindow();
      return tauriWindow;
    }

    // Fallback: core invoke (should exist when withGlobalTauri is enabled).
    // We assume the main window label is "main" (default in Tauri when not specified).
    const invoke = tauri?.core?.invoke;
    if (typeof invoke === "function") {
      tauriWindow = {
        label: "main",
        startDragging: () => invoke("plugin:window|start_dragging", { label: "main" }),
        toggleMaximize: () => invoke("plugin:window|toggle_maximize", { label: "main" }),
        isFullscreen: () => invoke("plugin:window|is_fullscreen", { label: "main" }),
        onResized: (handler: (e: unknown) => void) => tauri?.event?.listen?.("tauri://resize", handler),
      };
      return tauriWindow;
    }

    return null;
  } catch {
    return null;
  }
}

export async function startDragging() {
  const win = await getTauriWindow();
  if (win) {
    try {
      await win.startDragging();
    } catch (error) {
      console.warn("[TauriWindow] startDragging failed", error);
    }
  }
}

export async function toggleMaximize() {
  const win = await getTauriWindow();
  if (win) {
    try {
      await win.toggleMaximize();
    } catch (error) {
      console.warn("[TauriWindow] toggleMaximize failed", error);
    }
  }
}

// Returns event handlers for drag region behavior
export function useTauriDragHandlers() {
  // Dragging should work on any desktop OS when running under Tauri.
  if (Platform.OS !== "web" || !isTauriEnvironment()) {
    return {};
  }

  return {
    onMouseDown: (e: React.MouseEvent) => {
      // Only handle primary button, ignore if clicking on interactive elements.
      // Tauri docs recommend using `e.detail` on mousedown for double-click maximize.
      if (typeof e.buttons === "number" ? e.buttons !== 1 : e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest("button, a, input, [role='button']")) return;

      // Prevent text selection when dragging
      e.preventDefault();

      // Double click to maximize, otherwise drag.
      if (e.detail === 2) {
        toggleMaximize();
      } else {
        startDragging();
      }
    },
  };
}

// Hook that returns traffic light padding, accounting for fullscreen state
// In fullscreen, traffic lights are hidden so no padding is needed
export function useTrafficLightPadding(): { left: number; top: number } {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (Platform.OS !== "web" || !getIsTauriMac()) return;

    let disposed = false;
    let cleanup: (() => void) | undefined;
    let didCleanup = false;

    function runCleanup() {
      if (!cleanup || didCleanup) return;
      didCleanup = true;
      try {
        void Promise.resolve(cleanup()).catch((error) => {
          console.warn("[TauriWindow] Failed to remove resize listener", error);
        });
      } catch (error) {
        console.warn("[TauriWindow] Failed to remove resize listener", error);
      }
    }

    async function setup() {
      const win = await getTauriWindow();
      if (!win) return;

      // Check initial fullscreen state
      const fullscreen = await win.isFullscreen();
      if (disposed) return;
      setIsFullscreen(fullscreen);

      // Listen for resize events which include fullscreen changes
      const unlisten = await win.onResized(async () => {
        if (disposed) return;
        const fs = await win.isFullscreen();
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

  if (!getIsTauriMac() || isFullscreen) {
    return { left: 0, top: 0 };
  }

  return {
    left: TAURI_TRAFFIC_LIGHT_WIDTH,
    top: TAURI_TRAFFIC_LIGHT_HEIGHT,
  };
}
