import { useCallback, useEffect, useRef } from "react";
import type { LayoutChangeEvent } from "react-native";
import { isNative } from "@/constants/platform";

const STICKY_PRESS_MAX_DURATION_MS = 500;
const STICKY_PRESS_MAX_DISTANCE = 12;

interface FileHeaderInteractionInput {
  path: string;
  enabled: boolean;
  onSelect?: (path: string) => void;
  onActivate?: (path: string) => void;
  onLayout?: (height: number) => void;
  stickyPressFallback?: boolean;
}

interface PressPointEvent {
  nativeEvent: { pageX: number; pageY: number };
}

interface PressOrigin {
  startedAt: number;
  pageX: number;
  pageY: number;
}

interface StickyPressReleaseInput {
  enabled: boolean;
  native: boolean;
  pressHandled: boolean;
  stickyPressFallback: boolean;
  pressOrigin: PressOrigin | null;
  releasedAt: number;
  pageX: number;
  pageY: number;
}

export interface FileHeaderInteraction {
  activate: () => void;
  select: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
  onPressIn: (event: PressPointEvent) => void;
  onPressOut: (event: PressPointEvent) => void;
  onLongPress: () => void;
}

export type FileHeaderPressPhase = "idle" | "pressed" | "released" | "handled" | "long";
export type FileHeaderPressEvent =
  | { type: "press-in" }
  | { type: "press-out"; stickyFallbackEligible: boolean }
  | { type: "press" }
  | { type: "long-press" }
  | { type: "fallback" };
export type FileHeaderPressEffect = "none" | "select" | "activate" | "defer-activate";

export function reduceFileHeaderPress(
  phase: FileHeaderPressPhase,
  event: FileHeaderPressEvent,
): { phase: FileHeaderPressPhase; effect: FileHeaderPressEffect } {
  if (event.type === "press-in") return { phase: "pressed", effect: "none" };
  if (event.type === "long-press") return { phase: "long", effect: "select" };
  if (event.type === "press-out") {
    if (phase === "released" || phase === "handled" || phase === "long") {
      return { phase, effect: "none" };
    }
    return event.stickyFallbackEligible && phase === "pressed"
      ? { phase: "released", effect: "defer-activate" }
      : { phase: "idle", effect: "none" };
  }
  if (event.type === "press") {
    return phase === "long" || phase === "handled"
      ? { phase: "handled", effect: "none" }
      : { phase: "handled", effect: "activate" };
  }
  return phase === "released"
    ? { phase: "handled", effect: "activate" }
    : { phase, effect: "none" };
}

export function shouldActivateStickyHeaderPress(input: StickyPressReleaseInput): boolean {
  if (
    !input.enabled ||
    !input.native ||
    input.pressHandled ||
    !input.stickyPressFallback ||
    !input.pressOrigin
  ) {
    return false;
  }
  const durationMs = input.releasedAt - input.pressOrigin.startedAt;
  const dx = input.pageX - input.pressOrigin.pageX;
  const dy = input.pageY - input.pressOrigin.pageY;
  return (
    durationMs <= STICKY_PRESS_MAX_DURATION_MS && Math.hypot(dx, dy) <= STICKY_PRESS_MAX_DISTANCE
  );
}

export function useFileHeaderInteraction(input: FileHeaderInteractionInput): FileHeaderInteraction {
  const {
    path,
    enabled,
    onSelect,
    onActivate,
    onLayout: notifyLayout,
    stickyPressFallback = false,
  } = input;
  const pressHandledRef = useRef(false);
  const pressOriginRef = useRef<PressOrigin | null>(null);
  const phaseRef = useRef<FileHeaderPressPhase>("idle");
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearFallback = useCallback(() => {
    if (fallbackTimerRef.current !== null) clearTimeout(fallbackTimerRef.current);
    fallbackTimerRef.current = null;
  }, []);

  useEffect(() => clearFallback, [clearFallback]);

  const select = useCallback(() => {
    if (enabled) onSelect?.(path);
  }, [enabled, onSelect, path]);

  const activate = useCallback(() => {
    if (!enabled) return;
    clearFallback();
    const transition = reduceFileHeaderPress(phaseRef.current, { type: "press" });
    phaseRef.current = transition.phase;
    if (transition.effect !== "activate") return;
    pressHandledRef.current = true;
    select();
    onActivate?.(path);
  }, [clearFallback, enabled, onActivate, path, select]);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      notifyLayout?.(event.nativeEvent.layout.height);
    },
    [notifyLayout],
  );

  const onPressIn = useCallback(
    (event: PressPointEvent) => {
      clearFallback();
      phaseRef.current = reduceFileHeaderPress(phaseRef.current, { type: "press-in" }).phase;
      pressHandledRef.current = false;
      pressOriginRef.current = {
        startedAt: Date.now(),
        pageX: event.nativeEvent.pageX,
        pageY: event.nativeEvent.pageY,
      };
    },
    [clearFallback],
  );

  const onLongPress = useCallback(() => {
    clearFallback();
    const transition = reduceFileHeaderPress(phaseRef.current, { type: "long-press" });
    phaseRef.current = transition.phase;
    pressHandledRef.current = true;
    if (transition.effect === "select") select();
  }, [clearFallback, select]);

  const onPressOut = useCallback(
    (event: PressPointEvent) => {
      const eligible = shouldActivateStickyHeaderPress({
        enabled,
        native: isNative,
        pressHandled: pressHandledRef.current,
        stickyPressFallback,
        pressOrigin: pressOriginRef.current,
        releasedAt: Date.now(),
        pageX: event.nativeEvent.pageX,
        pageY: event.nativeEvent.pageY,
      });
      const transition = reduceFileHeaderPress(phaseRef.current, {
        type: "press-out",
        stickyFallbackEligible: eligible,
      });
      phaseRef.current = transition.phase;
      if (transition.effect === "defer-activate") {
        clearFallback();
        fallbackTimerRef.current = setTimeout(() => {
          fallbackTimerRef.current = null;
          const fallback = reduceFileHeaderPress(phaseRef.current, { type: "fallback" });
          phaseRef.current = fallback.phase;
          if (fallback.effect === "activate") {
            pressHandledRef.current = true;
            select();
            onActivate?.(path);
          }
        }, 0);
      }
    },
    [clearFallback, enabled, onActivate, path, select, stickyPressFallback],
  );

  return { activate, select, onLayout, onPressIn, onPressOut, onLongPress };
}
