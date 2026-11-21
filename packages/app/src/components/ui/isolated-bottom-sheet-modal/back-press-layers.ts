import type { BackPressSource } from "./visibility-tracker";

/**
 * Two Back layers over one platform listener. Overlays (bottom sheets, sheet tabs, the
 * fullscreen composer) are offered the press before screens, newest first within each layer.
 * Order between the layers does not depend on when they subscribed: a layout change can
 * remount an overlay and a screen in one commit, children first, and the screen must still
 * not take Back from the overlay.
 */
export function createBackPressLayers(platform: BackPressSource): {
  overlay: BackPressSource;
  screen: BackPressSource;
} {
  const overlays: { onBackPress: () => boolean }[] = [];
  const screens: { onBackPress: () => boolean }[] = [];
  let unsubscribePlatform: (() => void) | null = null;

  const offer = (listeners: { onBackPress: () => boolean }[]) => {
    for (let index = listeners.length - 1; index >= 0; index--) {
      if (listeners[index]?.onBackPress()) return true;
    }
    return false;
  };

  const sync = () => {
    const wanted = overlays.length > 0 || screens.length > 0;
    if (wanted && !unsubscribePlatform) {
      unsubscribePlatform = platform.subscribe(() => offer(overlays) || offer(screens));
    } else if (!wanted && unsubscribePlatform) {
      unsubscribePlatform();
      unsubscribePlatform = null;
    }
  };

  const layer = (listeners: { onBackPress: () => boolean }[]): BackPressSource => ({
    subscribe(onBackPress) {
      const entry = { onBackPress };
      listeners.push(entry);
      sync();
      return () => {
        const index = listeners.indexOf(entry);
        if (index < 0) return;
        listeners.splice(index, 1);
        sync();
      };
    },
  });

  return { overlay: layer(overlays), screen: layer(screens) };
}
