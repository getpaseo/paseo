import { useEffect } from "react";

const ANNOTATION_SURFACE_SELECTOR =
  '[data-testid="composer-selected-text-annotations"], [data-testid="composer-selected-text-annotations-details"]';

export function useSelectedTextAnnotationsDismiss({
  visible,
  onDismiss,
}: {
  visible: boolean;
  onDismiss: () => void;
}): void {
  useEffect(() => {
    if (!visible) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(ANNOTATION_SURFACE_SELECTOR)) return;
      onDismiss();
    };
    const handleWindowBlur = () => onDismiss();
    const handleVisibilityChange = () => {
      if (document.hidden) onDismiss();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [onDismiss, visible]);
}
