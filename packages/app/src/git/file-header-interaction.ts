import { useCallback, useRef } from "react";
import type { LayoutChangeEvent } from "react-native";

interface FileHeaderInteractionInput {
  path: string;
  enabled: boolean;
  onSelect?: (path: string) => void;
  onActivate?: (path: string) => void;
  onLayout?: (height: number) => void;
}

export interface FileHeaderInteraction {
  activate: () => void;
  select: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
  onPressIn: () => void;
  onLongPress: () => void;
}

export type FileHeaderPressPhase = "idle" | "pressed" | "long" | "handled";
export type FileHeaderPressEvent =
  | { type: "press-in" }
  | { type: "press" }
  | { type: "long-press" };
export type FileHeaderPressEffect = "none" | "select" | "activate";

export function reduceFileHeaderPress(
  phase: FileHeaderPressPhase,
  event: FileHeaderPressEvent,
): { phase: FileHeaderPressPhase; effect: FileHeaderPressEffect } {
  if (event.type === "press-in") return { phase: "pressed", effect: "none" };
  if (event.type === "long-press") return { phase: "long", effect: "select" };
  return phase === "long" || phase === "handled"
    ? { phase: "handled", effect: "none" }
    : { phase: "handled", effect: "activate" };
}

export function useFileHeaderInteraction(input: FileHeaderInteractionInput): FileHeaderInteraction {
  const { path, enabled, onSelect, onActivate, onLayout: notifyLayout } = input;
  const phaseRef = useRef<FileHeaderPressPhase>("idle");

  const select = useCallback(() => {
    if (enabled) onSelect?.(path);
  }, [enabled, onSelect, path]);

  const activate = useCallback(() => {
    if (!enabled) return;
    const transition = reduceFileHeaderPress(phaseRef.current, { type: "press" });
    phaseRef.current = transition.phase;
    if (transition.effect !== "activate") return;
    select();
    onActivate?.(path);
  }, [enabled, onActivate, path, select]);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      notifyLayout?.(event.nativeEvent.layout.height);
    },
    [notifyLayout],
  );

  const onPressIn = useCallback(() => {
    phaseRef.current = reduceFileHeaderPress(phaseRef.current, { type: "press-in" }).phase;
  }, []);

  const onLongPress = useCallback(() => {
    const transition = reduceFileHeaderPress(phaseRef.current, { type: "long-press" });
    phaseRef.current = transition.phase;
    if (transition.effect === "select") select();
  }, [select]);

  return { activate, select, onLayout, onPressIn, onLongPress };
}
