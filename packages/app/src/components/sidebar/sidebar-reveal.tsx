import { useEffect, type ReactNode, type RefObject } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { getRevealRowRef, useSidebarRevealStore } from "@/components/sidebar/sidebar-reveal-store";

/** Anything scrollable that can jump to a content offset: RN ScrollView and the draggable
 * flatlist's nestable container both answer to `scrollTo`. */
export interface RevealScrollTarget {
  scrollTo(options: { x?: number; y?: number; animated?: boolean }): void;
}

const REVEAL_TOP_MARGIN = 16;
const REVEAL_REQUEST_TTL_MS = 5000;
/** The animated scroll gets this long to land before the row starts flashing. */
const REVEAL_FLASH_LEAD_MS = 280;

const FLASH_MAX_OPACITY = 0.24;
const FLASH_PULSE_IN_MS = 110;
const FLASH_PULSE_OUT_MS = 180;

/**
 * The scroll-owner half of "Reveal in sidebar". Mounted once per sidebar list (the component that
 * owns the scroll container): watches the reveal request, waits for the row to exist — filters,
 * collapsed sections, and hydration may still be settling — scrolls it into view, then hands off
 * to the row's flash overlay.
 */
export function useSidebarRevealScroller(input: {
  scrollRef: RefObject<RevealScrollTarget | null>;
  contentRef: RefObject<View | null>;
}): void {
  const { scrollRef, contentRef } = input;
  const request = useSidebarRevealStore((state) => state.request);
  useEffect(() => {
    if (!request) return;
    const { workspaceKey, token, createdAt } = request;
    let cancelled = false;
    let frame = 0;
    let flashDelay: ReturnType<typeof setTimeout> | null = null;

    const teardown = () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
      if (flashDelay) clearTimeout(flashDelay);
    };

    const attempt = () => {
      if (cancelled) return;
      if (Date.now() - createdAt > REVEAL_REQUEST_TTL_MS) {
        useSidebarRevealStore.getState().consumeRequest(token);
        return;
      }
      const row = getRevealRowRef(workspaceKey)?.current ?? null;
      const content = contentRef.current;
      const scroll = scrollRef.current;
      if (!row || !content || !scroll) {
        frame = requestAnimationFrame(attempt);
        return;
      }
      row.measureLayout(
        content,
        (_left, top, _width, height) => {
          if (cancelled) return;
          // A zero box means the row is not laid out yet (hidden or hydrating surface).
          if (height <= 0) {
            frame = requestAnimationFrame(attempt);
            return;
          }
          scroll.scrollTo({ x: 0, y: Math.max(0, top - REVEAL_TOP_MARGIN), animated: true });
          flashDelay = setTimeout(() => {
            flashDelay = null;
            useSidebarRevealStore.getState().beginFlash({ workspaceKey, token });
            useSidebarRevealStore.getState().consumeRequest(token);
          }, REVEAL_FLASH_LEAD_MS);
        },
        () => {
          if (!cancelled) frame = requestAnimationFrame(attempt);
        },
      );
    };

    frame = requestAnimationFrame(attempt);
    return teardown;
  }, [contentRef, request, scrollRef]);
}

/**
 * A workspace row's reveal highlight: two soft accent pulses over the row, then a single slower
 * pulse when reduced motion is on. Fires on the store's flash state and clears it when done.
 */
export function SidebarRevealFlashOverlay({ workspaceKey }: { workspaceKey: string }) {
  const flash = useSidebarRevealStore((state) => state.flash);
  const completeFlash = useSidebarRevealStore((state) => state.completeFlash);
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(0);
  const isTarget = flash !== null && flash.workspaceKey === workspaceKey;

  useEffect(() => {
    if (!isTarget || !flash) return;
    const token = flash.token;
    const finish = () => completeFlash(token);
    if (reducedMotion) {
      opacity.value = withTiming(FLASH_MAX_OPACITY, { duration: FLASH_PULSE_IN_MS }, (done) => {
        if (!done) return;
        opacity.value = withTiming(0, { duration: 3 * FLASH_PULSE_OUT_MS }, (settled) => {
          if (settled) runOnJS(finish)();
        });
      });
    } else {
      opacity.value = withSequence(
        withTiming(FLASH_MAX_OPACITY, { duration: FLASH_PULSE_IN_MS }),
        withTiming(0, { duration: FLASH_PULSE_OUT_MS }),
        withTiming(FLASH_MAX_OPACITY, { duration: FLASH_PULSE_IN_MS }),
        withTiming(0, { duration: FLASH_PULSE_OUT_MS }, (settled) => {
          if (settled) runOnJS(finish)();
        }),
      );
    }
    return () => {
      cancelAnimation(opacity);
      opacity.value = 0;
    };
  }, [completeFlash, flash, isTarget, opacity, reducedMotion]);

  const overlayStyle = useAnimatedStyle(() => ({ opacity: opacity.value }), [opacity]);
  if (!isTarget) return null;
  return <Animated.View pointerEvents="none" style={[styles.flashOverlay, overlayStyle]} />;
}

/**
 * Coordinate origin for reveal measurements: the direct child of the scroll container that wraps
 * every row, so a row's measured top is its content-space offset.
 */
export function SidebarRevealContentAnchor({
  contentRef,
  children,
}: {
  contentRef: RefObject<View | null>;
  children: ReactNode;
}) {
  return (
    <View collapsable={false} ref={contentRef}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  flashOverlay: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.accentBright,
  },
}));
