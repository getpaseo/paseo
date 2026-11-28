import { useComposerHardwareBackExit } from "./hardware-back-exit";
import { useOverlayRegistration } from "@/keyboard";
import { useOverlayLayer } from "@/lib/overlay-root";

/**
 * Escape leaves fullscreen before app shortcuts see it. The registration only claims
 * keys; focus stays where the user left it because the editor never remounts.
 */
export function useComposerFullscreenExit(
  active: boolean,
  onExit: () => void,
): ((node: unknown) => void) | undefined {
  useComposerHardwareBackExit(active, onExit);
  const layer = useOverlayLayer("modal");
  return useOverlayRegistration({
    keys: ["Escape"],
    active,
    layer,
    manageFocus: false,
    onKeyDown: (event) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      onExit();
      return true;
    },
  });
}
