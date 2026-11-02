import { useOverlayLayer, useWebOverlayRegistration } from "@/lib/overlay-root";

/**
 * Escape leaves fullscreen before app shortcuts see it. The registration only claims
 * keys; focus stays where the user left it because the editor never remounts.
 */
export function useComposerFullscreenExit(
  active: boolean,
  onExit: () => void,
): ((node: unknown) => void) | undefined {
  const layer = useOverlayLayer("modal");
  return useWebOverlayRegistration({
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
