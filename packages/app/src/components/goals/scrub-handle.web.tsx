import { useCallback, useEffect, useMemo, useRef, type ReactElement } from "react";
import { View, type PointerEvent as RNPointerEvent } from "react-native";
import type { ScrubHandleProps } from "./scrub-handle.types";

const HANDLE_WEB_STYLE = {
  cursor: "ew-resize",
  // Vertical touch drags still scroll the sheet; horizontal ones reach the handle.
  touchAction: "pan-y",
  userSelect: "none",
} as object;

const DISABLED_WEB_STYLE = { cursor: "default" } as object;

/**
 * Web and Electron: pointer events, so a mouse and a touch screen both scrub, and Shift is read
 * from every move.
 */
export function ScrubHandle(props: ScrubHandleProps): ReactElement {
  const callbacks = useRef(props);
  callbacks.current = props;
  const cleanupRef = useRef<(() => void) | null>(null);

  // A drag still running when the field unmounts must not leave listeners or the cursor behind.
  useEffect(() => () => cleanupRef.current?.(), []);

  const handlePointerDown = useCallback((event: RNPointerEvent) => {
    if (callbacks.current.disabled || cleanupRef.current || event.nativeEvent.button > 0) {
      return;
    }
    const element = event.currentTarget as unknown as HTMLElement | null;
    const pointerId = event.nativeEvent.pointerId;
    const startX = event.nativeEvent.clientX;
    const cursorBefore = document.body.style.cursor;
    // Keeps focus in the text field and stops text selection while dragging.
    event.preventDefault();
    element?.setPointerCapture?.(pointerId);
    document.body.style.cursor = "ew-resize";
    callbacks.current.onScrubStart();

    function handleMove(moveEvent: PointerEvent): void {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      moveEvent.preventDefault();
      callbacks.current.onScrubMove(moveEvent.clientX - startX, moveEvent.shiftKey);
    }

    function handleEnd(endEvent: PointerEvent): void {
      if (endEvent.pointerId === pointerId) {
        cleanup();
      }
    }

    function cleanup(): void {
      cleanupRef.current = null;
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
      if (element?.hasPointerCapture?.(pointerId)) {
        element.releasePointerCapture(pointerId);
      }
      document.body.style.cursor = cursorBefore;
      callbacks.current.onScrubEnd();
    }

    cleanupRef.current = cleanup;
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleEnd);
    window.addEventListener("pointercancel", handleEnd);
  }, []);

  const accessibilityValue = useMemo(
    () => ({ text: props.accessibilityValueText }),
    [props.accessibilityValueText],
  );
  const accessibilityState = useMemo(() => ({ disabled: props.disabled }), [props.disabled]);
  const style = useMemo(
    () => [props.style, props.disabled ? DISABLED_WEB_STYLE : HANDLE_WEB_STYLE],
    [props.disabled, props.style],
  );

  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      accessibilityValue={accessibilityValue}
      accessibilityState={accessibilityState}
      accessibilityActions={props.accessibilityActions}
      onAccessibilityAction={props.onAccessibilityAction}
      onPointerDown={handlePointerDown}
      style={style}
      testID={props.testID}
    >
      {props.children}
    </View>
  );
}
