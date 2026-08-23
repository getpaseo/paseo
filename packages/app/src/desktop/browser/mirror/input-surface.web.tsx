import React, { useEffect, useRef, type RefObject } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { BrowserMirrorInput, BrowserMirrorInputSurfaceProps } from "./input-surface.types";
import { toGuestPoint, type GuestPoint, type GuestViewport } from "./viewport";

type MouseInput = Extract<BrowserMirrorInput, { kind: "mouse" }>;
type MouseModifier = MouseInput["modifiers"][number];
type MousePhase = NonNullable<MouseInput["phase"]>;

// Firefox reports wheel deltas in lines, and page-mode deltas scroll a viewport.
const WHEEL_LINE_HEIGHT_PX = 16;
const WHEEL_DELTA_MODE_LINE = 1;
const WHEEL_DELTA_MODE_PAGE = 2;
const MAX_CLICK_COUNT = 3;

/**
 * A real pointer, so the guest gets the phases it needs: press, drag, release.
 * The browser counts clicks for us, which is where double-click selection and
 * triple-click line selection come from.
 */
export function BrowserMirrorInputSurface({
  fit,
  guest,
  isInteractive,
  onInput,
  onFocusKeyboard,
  onLayout,
  children,
}: BrowserMirrorInputSurfaceProps) {
  const containerRef = useRef<View>(null);
  const state = useRef<SurfaceState>({ fit, guest, isInteractive, onInput, onFocusKeyboard });
  useEffect(() => {
    state.current = { fit, guest, isInteractive, onInput, onFocusKeyboard };
  });

  // Listeners attach once and read the latest props through the ref: a drag
  // must survive the frame resizing under it.
  useEffect(() => {
    const element = containerRef.current as unknown as HTMLElement | null;
    if (!element) {
      return;
    }
    return attachMouseInput(element, state);
  }, []);

  return (
    <View ref={containerRef} style={styles.container} onLayout={onLayout}>
      {children}
    </View>
  );
}

interface SurfaceState {
  fit: BrowserMirrorInputSurfaceProps["fit"];
  guest: GuestViewport;
  isInteractive: boolean;
  onInput: (event: BrowserMirrorInput) => void;
  onFocusKeyboard: () => void;
}

function attachMouseInput(element: HTMLElement, state: RefObject<SurfaceState>): () => void {
  let isDragging = false;
  let pendingMove: MouseEvent | null = null;
  let moveFrame = 0;

  function guestPoint(event: MouseEvent): GuestPoint | null {
    const { fit, guest } = state.current;
    if (!fit) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    const panePoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    return toGuestPoint(panePoint, fit, guest);
  }

  function sendMouse(event: MouseEvent, phase: MousePhase): void {
    const point = guestPoint(event);
    if (!point) {
      return;
    }
    state.current.onInput({
      kind: "mouse",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: clickCount(event),
      modifiers: modifiers(event),
      phase,
    });
  }

  function cancelPendingMove(): void {
    if (moveFrame !== 0) {
      cancelAnimationFrame(moveFrame);
    }
    moveFrame = 0;
    pendingMove = null;
  }

  function flushMove(): void {
    moveFrame = 0;
    const event = pendingMove;
    pendingMove = null;
    if (event) {
      sendMouse(event, "move");
    }
  }

  function handleDown(event: MouseEvent): void {
    if (!state.current.isInteractive || event.button !== 0) {
      return;
    }
    // The guest owns the selection; keep the viewer from selecting the frame
    // image or dragging it away as a ghost.
    event.preventDefault();
    isDragging = true;
    sendMouse(event, "down");
    state.current.onFocusKeyboard();
  }

  function handleMove(event: MouseEvent): void {
    if (!isDragging) {
      return;
    }
    pendingMove = event;
    if (moveFrame === 0) {
      moveFrame = requestAnimationFrame(flushMove);
    }
  }

  function handleUp(event: MouseEvent): void {
    if (!isDragging) {
      return;
    }
    isDragging = false;
    cancelPendingMove();
    sendMouse(event, "up");
  }

  function handleWheel(event: WheelEvent): void {
    if (!state.current.isInteractive) {
      return;
    }
    const point = guestPoint(event);
    if (!point) {
      return;
    }
    event.preventDefault();
    const scale = wheelDeltaScale(event.deltaMode, state.current.guest);
    state.current.onInput({
      kind: "wheel",
      x: point.x,
      y: point.y,
      deltaX: event.deltaX * scale,
      deltaY: event.deltaY * scale,
    });
  }

  element.addEventListener("mousedown", handleDown);
  element.addEventListener("wheel", handleWheel, { passive: false });
  // Window-level, so a selection that runs past the pane edge stays alive.
  window.addEventListener("mousemove", handleMove);
  window.addEventListener("mouseup", handleUp);

  return () => {
    cancelPendingMove();
    element.removeEventListener("mousedown", handleDown);
    element.removeEventListener("wheel", handleWheel);
    window.removeEventListener("mousemove", handleMove);
    window.removeEventListener("mouseup", handleUp);
  };
}

function clickCount(event: MouseEvent): number {
  return Math.min(Math.max(event.detail, 1), MAX_CLICK_COUNT);
}

function modifiers(event: MouseEvent): MouseModifier[] {
  const held: MouseModifier[] = [];
  if (event.altKey) {
    held.push("Alt");
  }
  if (event.ctrlKey) {
    held.push("Control");
  }
  if (event.metaKey) {
    held.push("Meta");
  }
  if (event.shiftKey) {
    held.push("Shift");
  }
  return held;
}

function wheelDeltaScale(deltaMode: number, guest: GuestViewport): number {
  if (deltaMode === WHEEL_DELTA_MODE_LINE) {
    return WHEEL_LINE_HEIGHT_PX;
  }
  if (deltaMode === WHEEL_DELTA_MODE_PAGE) {
    return guest.deviceHeight;
  }
  return 1;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
