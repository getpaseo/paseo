import { useEffect, useState } from "react";
import {
  resolveWindowControlsOverlayInsets,
  type WindowControlsOverlayMeasurement,
} from "@/utils/window-controls-overlay";

interface WindowControlsOverlayLike extends EventTarget {
  visible: boolean;
  getTitlebarAreaRect(): { x: number; y: number; width: number; height: number };
}

function isWindowControlsOverlay(value: unknown): value is WindowControlsOverlayLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    "visible" in value &&
    typeof value.visible === "boolean" &&
    "getTitlebarAreaRect" in value &&
    typeof value.getTitlebarAreaRect === "function"
  );
}

function getWindowControlsOverlay(): WindowControlsOverlayLike | null {
  if (typeof navigator === "undefined" || !("windowControlsOverlay" in navigator)) {
    return null;
  }
  const candidate = (navigator as Navigator & { windowControlsOverlay?: unknown })
    .windowControlsOverlay;
  if (!isWindowControlsOverlay(candidate)) {
    return null;
  }
  return candidate;
}

function readMeasurement(): WindowControlsOverlayMeasurement | null {
  const overlay = getWindowControlsOverlay();
  if (!overlay) {
    return null;
  }
  if (!overlay.visible) {
    return { visible: false };
  }
  const insets = resolveWindowControlsOverlayInsets({
    titlebarAreaRect: overlay.getTitlebarAreaRect(),
    viewportWidth: window.innerWidth,
  });
  if (!insets) {
    return null;
  }
  return { visible: true, insets };
}

function isSameMeasurement(
  a: WindowControlsOverlayMeasurement | null,
  b: WindowControlsOverlayMeasurement | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (!a.visible && !b.visible) return true;
  if (a.visible && b.visible) {
    return (
      a.insets.leftWidth === b.insets.leftWidth &&
      a.insets.rightWidth === b.insets.rightWidth &&
      a.insets.height === b.insets.height
    );
  }
  return false;
}

export function useWindowControlsOverlay(): WindowControlsOverlayMeasurement | null {
  const [measurement, setMeasurement] = useState<WindowControlsOverlayMeasurement | null>(() =>
    readMeasurement(),
  );

  useEffect(() => {
    let active = true;
    let frame: number | null = null;

    function measure() {
      if (!active) return;
      const next = readMeasurement();
      setMeasurement((prev) => (isSameMeasurement(prev, next) ? prev : next));
    }

    // A drag-resize fires geometrychange and resize together, and Chromium emits
    // geometrychange several times per resize as intermediate layout passes report
    // intermediate rectangles. Each read touches window.innerWidth, so coalesce to one
    // per frame instead of forcing layout on every event.
    function schedule() {
      if (!active || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    }

    measure();

    const overlay = getWindowControlsOverlay();
    overlay?.addEventListener("geometrychange", schedule);
    window.addEventListener("resize", schedule);

    return () => {
      active = false;
      if (frame !== null) cancelAnimationFrame(frame);
      overlay?.removeEventListener("geometrychange", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return measurement;
}
