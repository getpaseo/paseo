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
  if (!isTauriEnvironment() || !getIsTauriMac()) {
    return null;
  }

  try {
    // @metro-ignore tells Metro to skip bundling this import
    // It will be resolved at runtime in Tauri's WebView
    const { getCurrentWindow } = await import(/* @metro-ignore */ "@tauri-apps/api/window");
    tauriWindow = getCurrentWindow();
    return tauriWindow;
  } catch {
    return null;
  }
}

export async function startDragging() {
  const win = await getTauriWindow();
  if (win) {
    await win.startDragging();
  }
}

export async function toggleMaximize() {
  const win = await getTauriWindow();
  if (win) {
    await win.toggleMaximize();
  }
}

// Returns event handlers for drag region behavior
export function useTauriDragHandlers() {
  if (Platform.OS !== "web" || !getIsTauriMac()) {
    return {};
  }

  return {
    onMouseDown: (e: React.MouseEvent) => {
      // Only handle left click, ignore if clicking on interactive elements
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest("button, a, input, [role='button']")) return;

      // Prevent text selection when dragging
      e.preventDefault();

      // Start dragging on mouse down
      startDragging();
    },
    onDoubleClick: (e: React.MouseEvent) => {
      // Ignore if clicking on interactive elements
      const target = e.target as HTMLElement;
      if (target.closest("button, a, input, [role='button']")) return;

      e.preventDefault();
      toggleMaximize();
    },
  };
}

// Hook that returns traffic light padding, accounting for fullscreen state
// In fullscreen, traffic lights are hidden so no padding is needed
export function useTrafficLightPadding(): { left: number; top: number } {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (Platform.OS !== "web" || !getIsTauriMac()) return;

    let unlisten: (() => void) | undefined;

    async function setup() {
      const win = await getTauriWindow();
      if (!win) return;

      // Check initial fullscreen state
      const fullscreen = await win.isFullscreen();
      setIsFullscreen(fullscreen);

      // Listen for resize events which include fullscreen changes
      unlisten = await win.onResized(async () => {
        const fs = await win.isFullscreen();
        setIsFullscreen(fs);
      });
    }

    setup();

    return () => {
      unlisten?.();
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
