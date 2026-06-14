import { useEffect, useRef } from "react";

export function isImeComposingKeyboardEvent(event: {
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return Boolean(event.isComposing) || event.keyCode === 229;
}

/**
 * On macOS (Chromium/Electron), `compositionend` fires *before* the Enter
 * `keydown` event, so `event.nativeEvent.isComposing` is already false by the
 * time the keypress handler runs. This hook attaches native DOM listeners and
 * defers the flag clear by one tick so the Enter handler can still see that
 * IME composition just ended.
 */
export function useNativeImeComposingRef(
  getElement: () => HTMLElement | null,
): React.MutableRefObject<boolean> {
  const isComposingRef = useRef(false);

  useEffect(() => {
    const el = getElement();
    if (!el) return;

    const onStart = () => {
      isComposingRef.current = true;
    };
    const onEnd = () => {
      // Defer so the Enter keydown handler still sees isComposing=true
      setTimeout(() => {
        isComposingRef.current = false;
      }, 0);
    };

    el.addEventListener("compositionstart", onStart);
    el.addEventListener("compositionend", onEnd);
    return () => {
      el.removeEventListener("compositionstart", onStart);
      el.removeEventListener("compositionend", onEnd);
    };
    // Empty deps: the element ref is stable after mount (set by useLayoutEffect
    // before this useEffect runs), so we only need to attach listeners once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return isComposingRef;
}
