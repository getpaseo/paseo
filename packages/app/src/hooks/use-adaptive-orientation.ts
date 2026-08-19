import { useEffect, useRef } from "react";
import { Platform, useWindowDimensions } from "react-native";
import * as ScreenOrientation from "expo-screen-orientation";

// Phones must stay portrait: in landscape a phone window is wide enough to
// cross the desktop layout breakpoint, which renders the desktop shell in a
// phone-sized window (crowded footer, compressed session list). Tablets keep
// free rotation — see getpaseo/paseo#1669 for the letterboxing this pair
// with the with-android-rotation config plugin fixes.
// Keyed off the window's short side so split-screen windows behave.
const TABLET_MIN_SHORT_SIDE = 600; // dp

export function useAdaptiveOrientation(): void {
  const { width, height } = useWindowDimensions();
  // Resize events arrive continuously while a split-screen or free-form
  // window is being dragged, and each lock/unlock call makes Android re-layout
  // the whole activity. Remember the last applied state so only actual
  // transitions (phone <-> tablet) hit the native orientation API.
  const lastLockedRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }
    const shortSide = Math.min(width, height);
    const shouldLock = shortSide < TABLET_MIN_SHORT_SIDE;
    if (lastLockedRef.current === shouldLock) {
      return;
    }
    lastLockedRef.current = shouldLock;
    if (shouldLock) {
      void ScreenOrientation.lockAsync(
        ScreenOrientation.OrientationLock.PORTRAIT_UP
      );
    } else {
      void ScreenOrientation.unlockAsync();
    }
  }, [width, height]);
}
