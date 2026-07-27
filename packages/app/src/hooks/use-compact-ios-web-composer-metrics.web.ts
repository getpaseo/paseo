import { useEffect } from "react";
import { useSharedValue } from "react-native-reanimated";
import {
  resolveWebAbsoluteDeviceFixedOffset,
  resolveWebComposerDockFillDepth,
} from "@/hooks/keyboard-shift-policy";
import { isAppleHandheldPlatform } from "@/utils/terminal-keys";
import type { CompactIosWebComposerMetrics } from "./use-compact-ios-web-composer-metrics";

const METRIC_EPSILON = 0.25;
const FOCUS_TRACKING_DURATION_MS = 1_200;
const VIEWPORT_TRACKING_DURATION_MS = 300;

function isIosWebRuntime(): boolean {
  return isAppleHandheldPlatform({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  });
}

export function useCompactIosWebComposerMetrics(enabled: boolean): CompactIosWebComposerMetrics {
  const isIosWeb = isIosWebRuntime();
  const offset = useSharedValue<number | null>(isIosWeb ? 0 : null);
  const dockFillDepth = useSharedValue(0);

  useEffect(() => {
    if (!enabled || !isIosWeb) {
      offset.value = isIosWeb ? 0 : null;
      dockFillDepth.value = 0;
      return;
    }

    const viewport = window.visualViewport;
    const root = document.getElementById("root");
    if (!viewport || !root) {
      return;
    }

    let layoutViewportHeight = root.getBoundingClientRect().height;
    let animationFrame: number | null = null;
    let trackUntil = 0;

    const updateMetrics = () => {
      const nextOffset = resolveWebAbsoluteDeviceFixedOffset({
        layoutViewportHeight,
        visualViewportHeight: viewport.height,
        visualViewportPageTop: viewport.pageTop,
      });
      if (offset.value === null || Math.abs(nextOffset - offset.value) > METRIC_EPSILON) {
        offset.value = nextOffset;
      }

      const nextDockFillDepth = resolveWebComposerDockFillDepth({
        layoutViewportHeight,
        visualViewportHeight: viewport.height,
      });
      if (Math.abs(nextDockFillDepth - dockFillDepth.value) > METRIC_EPSILON) {
        dockFillDepth.value = nextDockFillDepth;
      }
    };

    const trackViewportFrame = (timestamp: number) => {
      updateMetrics();
      if (timestamp < trackUntil) {
        animationFrame = window.requestAnimationFrame(trackViewportFrame);
      } else {
        animationFrame = null;
      }
    };

    const startFrameTracking = (duration: number) => {
      trackUntil = Math.max(trackUntil, performance.now() + duration);
      updateMetrics();
      if (animationFrame === null) {
        animationFrame = window.requestAnimationFrame(trackViewportFrame);
      }
    };

    const handleViewportChange = () => {
      startFrameTracking(VIEWPORT_TRACKING_DURATION_MS);
    };

    const handleFocusChange = (event: FocusEvent) => {
      if (event.target instanceof HTMLTextAreaElement) {
        startFrameTracking(FOCUS_TRACKING_DURATION_MS);
      }
    };

    const rootResizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) {
        return;
      }
      const borderBoxSize = entry.borderBoxSize[0];
      layoutViewportHeight = borderBoxSize?.blockSize ?? entry.contentRect.height;
      updateMetrics();
    });

    rootResizeObserver.observe(root);
    updateMetrics();
    viewport.addEventListener("resize", handleViewportChange);
    viewport.addEventListener("scroll", handleViewportChange);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange);
    window.addEventListener("focusin", handleFocusChange);
    window.addEventListener("focusout", handleFocusChange);

    return () => {
      rootResizeObserver.disconnect();
      viewport.removeEventListener("resize", handleViewportChange);
      viewport.removeEventListener("scroll", handleViewportChange);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange);
      window.removeEventListener("focusin", handleFocusChange);
      window.removeEventListener("focusout", handleFocusChange);
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      offset.value = isIosWeb ? 0 : null;
      dockFillDepth.value = 0;
    };
  }, [dockFillDepth, enabled, isIosWeb, offset]);

  return { offset, dockFillDepth };
}
