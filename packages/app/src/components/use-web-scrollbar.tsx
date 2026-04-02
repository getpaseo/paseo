import { useCallback, useEffect, useState, type ReactNode, type RefObject } from "react";
import {
  Platform,
  type FlatList,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
} from "react-native";
import {
  WebDesktopScrollbarOverlay,
  useWebDesktopScrollbarMetrics,
  type ScrollbarMetrics,
} from "./web-desktop-scrollbar";

const METRICS_EPSILON = 0.5;
const HIDE_SCROLLBAR_STYLE_ID = "paseo-hide-scrollbar";

function ensureHideScrollbarStyle(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(HIDE_SCROLLBAR_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = HIDE_SCROLLBAR_STYLE_ID;
  style.textContent =
    "[data-hide-scrollbar]::-webkit-scrollbar { display: none; width: 0; height: 0; }";
  document.head.appendChild(style);
}

function metricsChanged(a: ScrollbarMetrics, b: ScrollbarMetrics): boolean {
  return (
    Math.abs(a.offset - b.offset) > METRICS_EPSILON ||
    Math.abs(a.viewportSize - b.viewportSize) > METRICS_EPSILON ||
    Math.abs(a.contentSize - b.contentSize) > METRICS_EPSILON
  );
}

// ── DOM element scrollbar ────────────────────────────────────────────
// Fully automatic: listens to scroll/input/resize events on the element,
// hides the native scrollbar, and returns a themed overlay or null.

export function useWebElementScrollbar(
  elementRef: RefObject<HTMLElement | null>,
  options?: {
    enabled?: boolean;
    contentRef?: RefObject<HTMLElement | null>;
  },
): ReactNode {
  const isWeb = Platform.OS === "web";
  const enabled = (options?.enabled ?? true) && isWeb;
  const contentRef = options?.contentRef;

  const [metrics, setMetrics] = useState<ScrollbarMetrics>({
    offset: 0,
    viewportSize: 0,
    contentSize: 0,
  });

  useEffect(() => {
    if (!enabled) return;
    const element = elementRef.current;
    if (!element) return;

    element.setAttribute("data-hide-scrollbar", "");
    (element.style as any).scrollbarWidth = "none";
    (element.style as any).msOverflowStyle = "none";
    ensureHideScrollbarStyle();

    function update() {
      const el = elementRef.current;
      if (!el) return;
      const next: ScrollbarMetrics = {
        offset: el.scrollTop,
        viewportSize: el.clientHeight,
        contentSize: el.scrollHeight,
      };
      setMetrics((prev) => (metricsChanged(prev, next) ? next : prev));
    }

    element.addEventListener("scroll", update, { passive: true });
    element.addEventListener("input", update, { passive: true });

    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(element);
    const contentElement = contentRef?.current;
    if (contentElement) {
      resizeObserver.observe(contentElement);
    }

    update();

    return () => {
      element.removeEventListener("scroll", update);
      element.removeEventListener("input", update);
      resizeObserver.disconnect();
      element.removeAttribute("data-hide-scrollbar");
      (element.style as any).scrollbarWidth = "";
      (element.style as any).msOverflowStyle = "";
    };
  }, [contentRef, elementRef, enabled]);

  const onScrollToOffset = useCallback(
    (offset: number) => {
      elementRef.current?.scrollTo({ top: offset, behavior: "auto" });
    },
    [elementRef],
  );

  if (!enabled) return null;

  return <WebDesktopScrollbarOverlay enabled metrics={metrics} onScrollToOffset={onScrollToOffset} />;
}

// ── RN ScrollView / FlatList scrollbar ───────────────────────────────
// Returns event handlers to wire onto your ScrollView/FlatList plus
// a renderable overlay. The overlay is null when disabled.

interface WebScrollViewScrollbar {
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onLayout: (event: LayoutChangeEvent) => void;
  onContentSizeChange: (width: number, height: number) => void;
  overlay: ReactNode;
}

export function useWebScrollViewScrollbar(
  scrollableRef: RefObject<ScrollView | FlatList | null>,
  options?: { enabled?: boolean },
): WebScrollViewScrollbar {
  const isWeb = Platform.OS === "web";
  const enabled = (options?.enabled ?? true) && isWeb;
  const metricsHook = useWebDesktopScrollbarMetrics();

  const onScrollToOffset = useCallback(
    (offset: number) => {
      const scrollable = scrollableRef.current;
      if (!scrollable) return;
      if ("scrollToOffset" in scrollable) {
        (scrollable as FlatList).scrollToOffset({ offset, animated: false });
      } else {
        (scrollable as ScrollView).scrollTo({ y: offset, animated: false });
      }
    },
    [scrollableRef],
  );

  const overlay: ReactNode = enabled ? (
    <WebDesktopScrollbarOverlay enabled metrics={metricsHook} onScrollToOffset={onScrollToOffset} />
  ) : null;

  return {
    onScroll: metricsHook.onScroll,
    onLayout: metricsHook.onLayout,
    onContentSizeChange: metricsHook.onContentSizeChange,
    overlay,
  };
}
