import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from "react";
import type { RefObject } from "react";
import type { View } from "react-native";

export interface PressDragTarget {
  onSelect: () => void;
  disabled?: boolean;
}

export interface PressDragSnapshot {
  dragging: boolean;
  target: unknown;
}

export interface PressDragSelection {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => PressDragSnapshot;
  registerTarget: (node: unknown, getTarget: () => PressDragTarget) => () => void;
  registerSurface: (node: unknown, kind: "content" | "backdrop") => () => void;
}

export interface PressDragOptions {
  anchorRef: RefObject<View | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabled: boolean;
}

const idle: PressDragSnapshot = { dragging: false, target: null };
const noop = () => {};
export const inertPressDragSelection: PressDragSelection = {
  subscribe: () => noop,
  getSnapshot: () => idle,
  registerTarget: () => noop,
  registerSurface: () => noop,
};

export const PressDragSelectionContext = createContext(inertPressDragSelection);

export function usePressDragState() {
  const selection = useContext(PressDragSelectionContext);
  return useSyncExternalStore(selection.subscribe, selection.getSnapshot, selection.getSnapshot);
}

/** Register the row's existing action, including custom/virtualized rows. */
export function usePressDragTarget(options: PressDragTarget) {
  const selection = useContext(PressDragSelectionContext);
  const latest = useRef(options);
  latest.current = options;
  const nodeRef = useRef<View | null>(null);
  const cleanup = useRef<(() => void) | undefined>(undefined);
  const ref = useCallback(
    (node: View | null) => {
      cleanup.current?.();
      nodeRef.current = node;
      cleanup.current = node ? selection.registerTarget(node, () => latest.current) : undefined;
    },
    [selection],
  );
  const state = usePressDragState();
  return {
    ref,
    dragging: state.dragging,
    hovered: state.dragging && state.target === nodeRef.current,
  };
}

export function usePressDragSurface(kind: "content" | "backdrop" = "content") {
  const selection = useContext(PressDragSelectionContext);
  const cleanup = useRef<(() => void) | undefined>(undefined);
  return useCallback(
    (node: View | null) => {
      cleanup.current?.();
      cleanup.current = node ? selection.registerSurface(node, kind) : undefined;
    },
    [selection, kind],
  );
}
