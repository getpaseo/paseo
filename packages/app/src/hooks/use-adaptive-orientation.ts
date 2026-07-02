import { useEffect } from "react";
import * as ScreenOrientation from "expo-screen-orientation";
import { useIsLargeScreenForm } from "@/constants/layout";
import { isNative } from "@/constants/platform";

/**
 * Locks phones to portrait, and unlocks rotation once the device is in a
 * large-screen form factor (tablet, or an unfolded foldable/tri-fold) so it
 * can rotate into landscape tablet layout.
 *
 * Native only — the web/desktop build has no screen-orientation lock. Tracks
 * `useIsLargeScreenForm()` (usable-area shortest side) so folding/unfolding
 * re-applies the correct lock automatically.
 */
export function useAdaptiveOrientation(): void {
  const isLargeScreen = useIsLargeScreenForm();

  useEffect(() => {
    if (!isNative) {
      return;
    }
    if (isLargeScreen) {
      void ScreenOrientation.unlockAsync();
    } else {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    }
  }, [isLargeScreen]);
}
